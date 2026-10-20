// Tipoff Moment Forecaster (Swift port of server/ml/forecaster.js).
//
// pMove30 = P(max |p(now+k) - p(now)| >= 0.05 for some k in (0, 30 min]);
// expectedMovePts = expected max |move| over the next 30 min, in points (0-100).
//
// Evaluates the XGBoost classifier + regressor exported to forecaster.json, with
// the same 1-minute resampling, feature definitions, Saabas driver attributions,
// rounding and logistic "heuristic" fallback as the JS module. Parity is checked
// against server/ml/forecaster_fixtures.json.
//
// Foundation only. All types are Sendable; ForecastModel is immutable after load
// and safe to share across actors.

import Foundation

// MARK: - Public API

struct PricePoint: Codable, Sendable, Hashable {
    var t: Date
    var p: Double   // 0...1
}

struct ForecastMarket: Sendable {
    var category: String
    var endDate: Date?
    var startTime: Date?
    /// "kalshi" sets the is_kalshi feature; anything else (or nil) does not.
    var source: String?
    /// Current probability (0...1); used as a single-point history when `history` is empty
    /// or has no point at or before `now`.
    var probability: Double?

    init(category: String = "other", endDate: Date? = nil, startTime: Date? = nil,
         source: String? = nil, probability: Double? = nil) {
        self.category = category
        self.endDate = endDate
        self.startTime = startTime
        self.source = source
        self.probability = probability
    }
}

struct ForecastDriver: Sendable, Hashable {
    var feature: String
    var impact: Double
    var value: Double?
}

struct MoveForecast: Sendable, Hashable {
    var pMove30: Double          // P(>=5pt move within 30 min), rounded to 1e-4
    var expectedMovePts: Double  // points (0-100), rounded to 0.01
    var drivers: [ForecastDriver]
    var model: String            // model id or "heuristic"
    var historyMinutes: Int
}

// MARK: - Model

/// Parsed forecaster.json. Immutable after init, so sharing across actors is safe.
final class ForecastModel: @unchecked Sendable {
    let id: String
    let features: [String]
    let params: FeatureParams
    let classifier: TreeEnsemble
    let regressor: TreeEnsemble
    let calibration: Calibration
    let heuristic: HeuristicModel
    /// For each model feature index, the index into the internal feature table (-1 = unknown -> NaN).
    let featureSlots: [Int]

    private init(id: String, features: [String], params: FeatureParams, classifier: TreeEnsemble,
                 regressor: TreeEnsemble, calibration: Calibration, heuristic: HeuristicModel) {
        self.id = id
        self.features = features
        self.params = params
        self.classifier = classifier
        self.regressor = regressor
        self.calibration = calibration
        self.heuristic = heuristic
        self.featureSlots = features.map { FeatureTable.index[$0] ?? -1 }
    }

    static func load(from url: URL) -> ForecastModel? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return load(data: data)
    }

    static func bundled() -> ForecastModel? {
        guard let url = Bundle.main.url(forResource: "forecaster", withExtension: "json") else { return nil }
        return load(from: url)
    }

    static func load(data: Data) -> ForecastModel? {
        guard let raw = try? JSONDecoder().decode(RawModel.self, from: data) else { return nil }
        let n = raw.features.count
        guard n > 0,
              let cls = TreeEnsemble(raw.classifier, nFeatures: n),
              let reg = TreeEnsemble(raw.regressor, nFeatures: n) else { return nil }
        let cal = Calibration(raw.classifier.calibration)
        let heur = raw.heuristic.flatMap(HeuristicModel.init) ?? .default
        return ForecastModel(id: raw.model ?? "xgboost-forecast", features: raw.features,
                             params: FeatureParams(raw.feature_params), classifier: cls,
                             regressor: reg, calibration: cal, heuristic: heur)
    }
}

struct FeatureParams: Sendable {
    var stepMs: Double = 60000
    var lookbackMin: Int = 360
    var moveMinDelta: Double = 0.03
    var moveWindowMin: Int = 10
    var moveCooldownMin: Int = 10
    var volEps: Double = 0.0005
    var gameLenH: Double = 4
    var liveEndH: Double = 6
    var minHistoryMin: Int = 30

    static let `default` = FeatureParams()

    fileprivate init() {}

    fileprivate init(_ r: RawFeatureParams?) {
        guard let r else { return }
        if let v = r.step_ms, v > 0 { stepMs = v }
        if let v = r.lookback_min, v >= 1 { lookbackMin = Int(v) }
        if let v = r.move_min_delta { moveMinDelta = v }
        if let v = r.move_window_min { moveWindowMin = Int(v) }
        if let v = r.move_cooldown_min { moveCooldownMin = Int(v) }
        if let v = r.vol_eps { volEps = v }
        if let v = r.game_len_h { gameLenH = v }
        if let v = r.live_end_h { liveEndH = v }
        if let v = r.min_history_min { minHistoryMin = Int(v.rounded(.up)) }
    }
}

/// All trees of one booster flattened into contiguous arrays (global node indices).
struct TreeEnsemble: Sendable {
    let baseMargin: Double
    let roots: [Int32]
    let feat: [Int32]    // < 0 = leaf
    let thr: [Double]    // float32 thresholds stored as Double
    let yes: [Int32]
    let no: [Int32]
    let miss: [Int32]
    let value: [Double]

    init?(_ r: RawEnsemble, nFeatures: Int) {
        guard !r.trees.isEmpty else { return nil }
        var roots = [Int32](), feat = [Int32](), thr = [Double](), yes = [Int32](), no = [Int32](),
            miss = [Int32](), value = [Double]()
        for t in r.trees {
            let c = t.f.count
            guard c > 0, t.t.count == c, t.y.count == c, t.n.count == c, t.m.count == c, t.v.count == c else { return nil }
            let off = feat.count
            roots.append(Int32(off))
            for i in 0..<c {
                let f = t.f[i]
                if f >= 0 {
                    // Children must be in range and strictly after the parent (guarantees termination).
                    guard f < nFeatures, t.y[i] > i, t.y[i] < c, t.n[i] > i, t.n[i] < c,
                          t.m[i] > i, t.m[i] < c else { return nil }
                }
                feat.append(Int32(f))
                thr.append(t.t[i])
                yes.append(Int32(off + max(t.y[i], 0)))
                no.append(Int32(off + max(t.n[i], 0)))
                miss.append(Int32(off + max(t.m[i], 0)))
                value.append(t.v[i])
            }
        }
        self.baseMargin = r.base_margin
        self.roots = roots; self.feat = feat; self.thr = thr
        self.yes = yes; self.no = no; self.miss = miss; self.value = value
    }

    /// Raw margin; if `contrib` is non-nil, adds per-feature Saabas path attributions into it.
    func margin(_ x: UnsafeBufferPointer<Double>, contrib: UnsafeMutableBufferPointer<Double>?) -> Double {
        var m = baseMargin
        feat.withUnsafeBufferPointer { feat in
        thr.withUnsafeBufferPointer { thr in
        yes.withUnsafeBufferPointer { yes in
        no.withUnsafeBufferPointer { no in
        miss.withUnsafeBufferPointer { miss in
        value.withUnsafeBufferPointer { value in
            for r in roots {
                var i = Int(r)
                while feat[i] >= 0 {
                    let f = Int(feat[i])
                    let v = x[f]
                    let next: Int
                    if v.isNaN { next = Int(miss[i]) }
                    else { next = Double(Float(v)) < thr[i] ? Int(yes[i]) : Int(no[i]) }
                    if let contrib { contrib[f] += value[next] - value[i] }
                    i = next
                }
                m += value[i]
            }
        }}}}}}
        return m
    }
}

enum Calibration: Sendable {
    case none
    case platt(a: Double, b: Double)
    case isotonic(x: [Double], y: [Double])

    init(_ r: RawCalibration?) {
        guard let r else { self = .none; return }
        switch r.type {
        case "platt":
            if let a = r.a, let b = r.b { self = .platt(a: a, b: b) } else { self = .none }
        case "isotonic":
            if let x = r.x, let y = r.y, !x.isEmpty, x.count == y.count { self = .isotonic(x: x, y: y) } else { self = .none }
        default:
            self = .none
        }
    }

    func apply(_ raw: Double) -> Double {
        switch self {
        case .none:
            return raw
        case let .platt(a, b):
            let r = min(max(raw, 1e-7), 1 - 1e-7)
            return 1 / (1 + exp(a * log(r / (1 - r)) + b))
        case let .isotonic(x, y):
            if raw <= x[0] { return y[0] }
            if raw >= x[x.count - 1] { return y[y.count - 1] }
            var lo = 0, hi = x.count - 1
            while hi - lo > 1 {
                let mid = (lo + hi) >> 1
                if x[mid] <= raw { lo = mid } else { hi = mid }
            }
            let span = x[hi] - x[lo]
            return span > 0 ? y[lo] + ((raw - x[lo]) * (y[hi] - y[lo])) / span : y[lo]
        }
    }
}

/// 6-input logistic fallback (inputs: h_vol30, h_range30, dist_mid, live_proxy, h_end_1h, cat_sports).
struct HeuristicModel: Sendable {
    let features: [String]
    let imputeVol30: Double
    let mean: [Double]
    let scale: [Double]
    let logitCoef: [Double]
    let logitIntercept: Double
    let moveCoef: [Double]
    let moveIntercept: Double

    fileprivate init?(_ r: RawHeuristic) {
        guard r.features.count == 6, r.mean.count == 6, r.scale.count == 6,
              r.logit_coef.count == 6, r.move_coef.count == 6 else { return nil }
        features = r.features; imputeVol30 = r.impute_vol30 ?? 0
        mean = r.mean; scale = r.scale
        logitCoef = r.logit_coef; logitIntercept = r.logit_intercept
        moveCoef = r.move_coef; moveIntercept = r.move_intercept
    }

    private init(features: [String], imputeVol30: Double, mean: [Double], scale: [Double],
                 logitCoef: [Double], logitIntercept: Double, moveCoef: [Double], moveIntercept: Double) {
        self.features = features; self.imputeVol30 = imputeVol30; self.mean = mean; self.scale = scale
        self.logitCoef = logitCoef; self.logitIntercept = logitIntercept
        self.moveCoef = moveCoef; self.moveIntercept = moveIntercept
    }

    /// Copy of forecaster.json "heuristic" (as embedded in forecaster.js) so the fallback works without the model file.
    static let `default` = HeuristicModel(
        features: ["h_vol30", "h_range30", "dist_mid", "live_proxy", "h_end_1h", "cat_sports"],
        imputeVol30: 0.0,
        mean: [0.016989160936992837, 0.03821772066358094, 0.16081204999999357, 0.016713333333333334, 0.0024533333333333334, 0.9046533333333333],
        scale: [0.035515037952081774, 0.08231789494060045, 0.13493338715851483, 0.12819515522228161, 0.04947033948722948, 0.2936931729253827],
        logitCoef: [0.25707143264685417, 0.7648397928609117, -0.675715010601695, 0.25747109654974687, 0.11788478201602091, -0.11358065443479258],
        logitIntercept: -4.329112263363615,
        moveCoef: [-0.0030526594688330953, 0.016655920483292366, -0.001559899757982329, 0.009831748169290944, 0.0007721660581816054, 5.898416345873401e-05],
        moveIntercept: 0.007502139999999872)

    /// (pMove30, expectedMovePts, contrib)
    func predict(_ inputs: [Double]) -> (Double, Double, [Double]) {
        var x = inputs
        if x[0].isNaN { x[0] = imputeVol30 }
        x[0] = max(x[0], 0).squareRoot()
        x[1] = max(x[1], 0).squareRoot()
        var zl = logitIntercept
        var mv = moveIntercept
        var contrib = [Double](repeating: 0, count: x.count)
        for i in 0..<x.count {
            let z = (x[i] - mean[i]) / scale[i]
            contrib[i] = logitCoef[i] * z
            zl += logitCoef[i] * z
            mv += moveCoef[i] * z
        }
        return (1 / (1 + exp(-zl)), 100 * max(mv, 0), contrib)
    }
}

// MARK: - Forecaster

enum Forecaster {
    static let categories = ["sports", "politics", "crypto", "economics", "entertainment", "weather", "tech", "other"]

    /// Mirrors forecastMove(market, history, now) in forecaster.js, including the heuristic fallback
    /// (used when model is nil or history covers < min_history_min) and the null cases.
    static func forecast(_ market: ForecastMarket, history: [PricePoint], now: Date = .now, model: ForecastModel?) -> MoveForecast? {
        let T = ms(now)
        guard T.isFinite else { return nil }
        var hist = history
        if hist.isEmpty {
            guard let p0 = market.probability, p0.isFinite else { return nil }
            hist = [PricePoint(t: now, p: p0)]
        }
        guard let r = computeFeatures(market, hist, T: T, params: model?.params ?? .default), r.f[F.p].isFinite else {
            // No usable point at or before `now`: retry with the current probability as a single point
            // (that point is at `now`, so the retry always yields a finite p and cannot recurse again).
            guard let p0 = market.probability, p0.isFinite else { return nil }
            return forecast(market, history: [PricePoint(t: now, p: p0)], now: now, model: model)
        }

        if let model, r.historyMinutes >= model.params.minHistoryMin {
            let n = model.features.count
            var x = [Double](repeating: .nan, count: n)
            for j in 0..<n where model.featureSlots[j] >= 0 { x[j] = r.f[model.featureSlots[j]] }
            var contrib = [Double](repeating: 0, count: n)
            let (cm, rm) = x.withUnsafeBufferPointer { xb in
                contrib.withUnsafeMutableBufferPointer { cb in
                    (model.classifier.margin(xb, contrib: cb), model.regressor.margin(xb, contrib: nil))
                }
            }
            let raw = 1 / (1 + exp(-cm))
            let p = model.calibration.apply(raw)
            let pts = 100 * max(rm, 0)
            if p.isFinite && pts.isFinite {
                return MoveForecast(pMove30: r4(p), expectedMovePts: jsRound(pts * 100) / 100,
                                    drivers: topDrivers(contrib, model.features, x),
                                    model: model.id, historyMinutes: r.historyMinutes)
            }
        }

        let h = model?.heuristic ?? .default
        let inputs = heuristicInputs(r.g, r.f)
        let (p, pts, contrib) = h.predict(inputs)
        guard p.isFinite else { return nil }
        return MoveForecast(pMove30: r4(p), expectedMovePts: jsRound(pts * 100) / 100,
                            drivers: topDrivers(contrib, h.features, inputs),
                            model: "heuristic", historyMinutes: r.historyMinutes)
    }

    // MARK: Internals (internal for the parity harness)

    struct Features {
        var f: [Double]          // indexed by F.*
        var g: [Double]          // 1-minute grid, oldest first, last = now
        var historyMinutes: Int
    }

    /// Feature vector in model.features order (NaN = missing).
    static func featureVector(_ market: ForecastMarket, _ history: [PricePoint], now: Date, model: ForecastModel) -> [Double]? {
        guard let r = computeFeatures(market, history, T: ms(now), params: model.params) else { return nil }
        return model.featureSlots.map { $0 >= 0 ? r.f[$0] : .nan }
    }

    @inline(__always) static func ms(_ d: Date) -> Double { (d.timeIntervalSince1970 * 1000).rounded() }

    static func computeFeatures(_ market: ForecastMarket, _ history: [PricePoint], T: Double, params fp: FeatureParams) -> Features? {
        guard T.isFinite else { return nil }
        let STEP = fp.stepMs, LOOK = fp.lookbackMin, EPS = fp.volEps

        // Clean: drop non-finite / future points, stable sort by t.
        var ts = [Double](), ps = [Double]()
        ts.reserveCapacity(history.count); ps.reserveCapacity(history.count)
        var sorted = true
        for q in history {
            let t = ms(q.t)
            let p = q.p
            if !t.isFinite || !p.isFinite || t > T { continue }
            if let last = ts.last, t < last { sorted = false }
            ts.append(t); ps.append(p)
        }
        if !sorted {
            let idx = ts.indices.sorted { ts[$0] != ts[$1] ? ts[$0] < ts[$1] : $0 < $1 }
            ts = idx.map { ts[$0] }
            ps = idx.map { ps[$0] }
        }

        // Resample: values at T - k*STEP for k = LOOK..0 (LOCF).
        let L = LOOK + 1
        var g = [Double](repeating: .nan, count: L)
        var j = -1
        for k in stride(from: LOOK, through: 0, by: -1) {
            let gt = T - Double(k) * STEP
            while j + 1 < ts.count && ts[j + 1] <= gt { j += 1 }
            if j >= 0 { g[LOOK - k] = ps[j] }
        }
        let p = g[L - 1]
        var nHist = 0
        for v in g where !v.isNaN { nHist += 1 }

        // Population std of valid consecutive diffs over the last nLast steps.
        func diffStd(_ nLast: Int, minCount: Int) -> Double {
            let from = max(L - nLast, 1)
            var s = 0.0, c = 0
            if from < L {
                for k in from..<L where !g[k].isNaN && !g[k - 1].isNaN { s += g[k] - g[k - 1]; c += 1 }
            }
            if c < minCount || c == 0 { return .nan }
            let m = s / Double(c)
            var q = 0.0
            for k in from..<L where !g[k].isNaN && !g[k - 1].isNaN { let d = (g[k] - g[k - 1]) - m; q += d * d }
            return (q / Double(c)).squareRoot()
        }
        let vol15 = diffStd(15, minCount: 10)
        let vol1 = diffStd(60, minCount: 20)
        let vol6 = diffStd(360, minCount: 60)
        let vr1 = vol15.isNaN || vol1.isNaN ? Double.nan : (vol15 + EPS) / (vol1 + EPS)
        let vr2 = vol1.isNaN || vol6.isNaN ? Double.nan : (vol1 + EPS) / (vol6 + EPS)
        func ret(_ mins: Int) -> Double {
            let bi = L - 1 - mins
            guard bi >= 0 else { return .nan }
            let a = g[L - 1], b = g[bi]
            return a.isNaN || b.isNaN ? .nan : a - b
        }
        let r5 = ret(5), r15 = ret(15), r60 = ret(60)

        var maxjump = Double.nan, active = Double.nan
        do {
            let from = max(L - 60, 1)
            var c = 0, nz = 0, mj = 0.0
            if from < L {
                for k in from..<L where !g[k].isNaN && !g[k - 1].isNaN {
                    let a = abs(g[k] - g[k - 1])
                    c += 1
                    if a > mj { mj = a }
                    if a > 1e-9 { nz += 1 }
                }
            }
            if c >= 20 { maxjump = mj; active = Double(nz) / Double(c) }
        }
        func rangeOf(_ from: Int) -> (Double, Double, Int) {
            var lo = Double.infinity, hi = -Double.infinity, n = 0
            var k = max(from, 0)
            while k < L {
                let v = g[k]
                if !v.isNaN { n += 1; if v < lo { lo = v }; if v > hi { hi = v } }
                k += 1
            }
            return n > 0 ? (lo, hi, n) : (.nan, .nan, 0)
        }
        let (lo1, hi1, n1) = rangeOf(L - 61)
        let range1 = n1 >= 2 ? hi1 - lo1 : Double.nan
        let (lo6, hi6, n6) = rangeOf(0)
        let range6 = n6 >= 2 ? hi6 - lo6 : Double.nan
        let pos6 = n6 >= 2 && hi6 - lo6 > 1e-9 && !p.isNaN ? (p - lo6) / (hi6 - lo6) : Double.nan

        // >= 3pt moves: detector replay on the grid.
        var nMoves = 0, lastFire = -1_000_000_000, lastCond = -1
        let MOVE = fp.moveMinDelta - 1e-9
        for k in 1..<max(L, 1) {
            let gk = g[k]
            if gk.isNaN { continue }
            var cond = false
            var jj = 1
            while jj <= fp.moveWindowMin && k - jj >= 0 {
                let gj = g[k - jj]
                if !gj.isNaN && abs(gk - gj) >= MOVE { cond = true; break }
                jj += 1
            }
            if cond {
                lastCond = k
                if k - lastFire >= fp.moveCooldownMin { nMoves += 1; lastFire = k }
            }
        }
        let minSince = lastCond >= 0 ? Double(L - 1 - lastCond) : Double.nan

        var cat = market.category
        if !categories.contains(cat) { cat = "other" }
        let end = market.endDate.map(ms).flatMap { $0.isFinite ? $0 : nil }
        let start = market.startTime.map(ms).flatMap { $0.isFinite ? $0 : nil }
        let HOUR = 3_600_000.0
        var lhte = Double.nan, pastEnd = Double.nan
        if let end {
            let h = (end - T) / HOUR
            lhte = log1p(max(h, 0))
            pastEnd = h < 0 ? 1 : 0
        }
        var startRel = Double.nan, live = 0.0
        if let start {
            let s = (T - start) / HOUR
            startRel = s >= 0 ? log1p(s) : -log1p(-s)
            live = s >= 0 && s <= fp.gameLenH ? 1 : 0
        } else if cat == "sports", let end {
            let h = (end - T) / HOUR
            live = h >= -1 && h <= fp.liveEndH ? 1 : 0
        }
        let days = (T / 86_400_000).rounded(.down)
        let hour = ((T - days * 86_400_000) / 3_600_000).rounded(.down)
        let dow = Double(((Int(days) + 3) % 7 + 7) % 7)

        var f = [Double](repeating: .nan, count: F.count)
        f[F.p] = p
        f[F.dist_mid] = abs(p - 0.5)
        f[F.dist_bound] = p.isNaN ? .nan : min(p, 1 - p)
        f[F.vol_15m] = vol15
        f[F.vol_1h] = vol1
        f[F.vol_6h] = vol6
        f[F.vr_15m_1h] = vr1
        f[F.vr_1h_6h] = vr2
        f[F.ret_5m] = r5
        f[F.ret_15m] = r15
        f[F.ret_1h] = r60
        f[F.abs_ret_5m] = abs(r5)
        f[F.abs_ret_15m] = abs(r15)
        f[F.abs_ret_1h] = abs(r60)
        f[F.maxjump_1h] = maxjump
        f[F.range_1h] = range1
        f[F.range_6h] = range6
        f[F.pos_range_6h] = pos6
        f[F.active_frac_1h] = active
        f[F.n_moves_6h] = Double(nMoves)
        f[F.min_since_move] = minSince
        f[F.log_hours_to_end] = lhte
        f[F.past_end] = pastEnd
        f[F.start_rel] = startRel
        f[F.live_proxy] = live
        f[F.hour_utc] = hour
        f[F.dow] = dow
        f[F.is_kalshi] = market.source == "kalshi" ? 1 : 0
        f[F.n_hist_min] = Double(nHist)
        for (i, c) in categories.enumerated() { f[F.cat_sports + i] = c == cat ? 1 : 0 }

        let historyMinutes = ts.isEmpty ? 0 : min(max(0, Int(((T - ts[0]) / 60000).rounded(.down))), LOOK)
        return Features(f: f, g: g, historyMinutes: historyMinutes)
    }

    /// Heuristic inputs from only the last 30 minutes of the grid (mirrors heuristicInputs in JS).
    static func heuristicInputs(_ g: [Double], _ f: [Double]) -> [Double] {
        let from = max(g.count - 31, 0)
        var s = 0.0, c = 0
        var lo = Double.infinity, hi = -Double.infinity, n = 0
        for k in from..<g.count {
            let v = g[k]
            if !v.isNaN { n += 1; if v < lo { lo = v }; if v > hi { hi = v } }
            if k > from && !v.isNaN && !g[k - 1].isNaN { s += v - g[k - 1]; c += 1 }
        }
        var vol = Double.nan
        if c >= 3 {
            let m = s / Double(c)
            var q = 0.0
            for k in (from + 1)..<g.count where !g[k].isNaN && !g[k - 1].isNaN { let d = (g[k] - g[k - 1]) - m; q += d * d }
            vol = (q / Double(c)).squareRoot()
        }
        let rng = n >= 2 ? hi - lo : 0
        let lhte = f[F.log_hours_to_end]
        let end1: Double = !lhte.isNaN && f[F.past_end] == 0 && lhte <= log1p(1) ? 1 : 0
        return [vol, rng, f[F.dist_mid], f[F.live_proxy], end1, f[F.cat_sports]]
    }

    /// JS Math.round: nearest integer, halves toward +infinity.
    @inline(__always) static func jsRound(_ x: Double) -> Double {
        let r = x.rounded(.down)
        return x - r >= 0.5 ? r + 1 : r
    }

    @inline(__always) static func r4(_ v: Double) -> Double { jsRound(v * 1e4) / 1e4 }

    static func topDrivers(_ contrib: [Double], _ names: [String], _ values: [Double]) -> [ForecastDriver] {
        var items: [(i: Int, impact: Double)] = []
        for i in 0..<min(contrib.count, names.count) {
            let imp = r4(contrib[i])
            if imp != 0 { items.append((i, imp)) }
        }
        items.sort { abs($0.impact) != abs($1.impact) ? abs($0.impact) > abs($1.impact) : $0.i < $1.i }
        return items.prefix(3).map { it in
            let v = it.i < values.count ? values[it.i] : .nan
            return ForecastDriver(feature: names[it.i], impact: it.impact, value: v.isFinite ? r4(v) : nil)
        }
    }
}

// MARK: - Feature table

/// Internal feature slots (names match forecaster.json "features").
enum F {
    static let p = 0, dist_mid = 1, dist_bound = 2, vol_15m = 3, vol_1h = 4, vol_6h = 5, vr_15m_1h = 6,
               vr_1h_6h = 7, ret_5m = 8, ret_15m = 9, ret_1h = 10, abs_ret_5m = 11, abs_ret_15m = 12,
               abs_ret_1h = 13, maxjump_1h = 14, range_1h = 15, range_6h = 16, pos_range_6h = 17,
               active_frac_1h = 18, n_moves_6h = 19, min_since_move = 20, log_hours_to_end = 21,
               past_end = 22, start_rel = 23, live_proxy = 24, hour_utc = 25, dow = 26, is_kalshi = 27,
               n_hist_min = 28, cat_sports = 29  // cat_* = 29...36 in Forecaster.categories order
    static let count = 37
}

enum FeatureTable {
    static let names: [String] = [
        "p", "dist_mid", "dist_bound", "vol_15m", "vol_1h", "vol_6h", "vr_15m_1h", "vr_1h_6h",
        "ret_5m", "ret_15m", "ret_1h", "abs_ret_5m", "abs_ret_15m", "abs_ret_1h", "maxjump_1h",
        "range_1h", "range_6h", "pos_range_6h", "active_frac_1h", "n_moves_6h", "min_since_move",
        "log_hours_to_end", "past_end", "start_rel", "live_proxy", "hour_utc", "dow", "is_kalshi",
        "n_hist_min",
    ] + Forecaster.categories.map { "cat_\($0)" }
    static let index: [String: Int] = Dictionary(uniqueKeysWithValues: names.enumerated().map { ($1, $0) })
}

// MARK: - JSON decoding (forecaster.json schema)

private struct RawModel: Decodable {
    var model: String?
    var features: [String]
    var feature_params: RawFeatureParams?
    var classifier: RawEnsemble
    var regressor: RawEnsemble
    var heuristic: RawHeuristic?
}

private struct RawFeatureParams: Decodable {
    var step_ms: Double?
    var lookback_min: Double?
    var move_min_delta: Double?
    var move_window_min: Double?
    var move_cooldown_min: Double?
    var vol_eps: Double?
    var game_len_h: Double?
    var live_end_h: Double?
    var min_history_min: Double?
}

struct RawEnsemble: Decodable {
    var base_margin: Double
    var trees: [RawTree]
    var calibration: RawCalibration?
}

struct RawTree: Decodable {
    var f: [Int]
    var t: [Double]
    var y: [Int]
    var n: [Int]
    var m: [Int]
    var v: [Double]
}

struct RawCalibration: Decodable {
    var type: String
    var a: Double?
    var b: Double?
    var x: [Double]?
    var y: [Double]?
}

private struct RawHeuristic: Decodable {
    var features: [String]
    var impute_vol30: Double?
    var mean: [Double]
    var scale: [Double]
    var logit_coef: [Double]
    var logit_intercept: Double
    var move_coef: [Double]
    var move_intercept: Double
}
