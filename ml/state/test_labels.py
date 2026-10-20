"""Hand-checked label expectations on real games (pytest, or run directly: python ml/state/test_labels.py).

Every expected value below was checked by hand against the ESPN play-by-play text and wallclocks
(cached under ml/state/data/raw/espn/; fetched from ESPN on first run). Minute t is labelled from
events with wallclock in (t - W, t], so an event at 13:58:17 first shows at minute 13:59.
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labels  # noqa: E402

_cache = {}


def L(sport, league, eid, side):
    k = (sport, league, eid, side)
    if k not in _cache:
        _cache[k] = labels.labels_for(sport, league, eid, side).set_index("minute_utc")
    return _cache[k]


def at(df, hhmm_utc):
    return df.loc[pd.Timestamp(hhmm_utc, tz="UTC"), "state"]


def span(df, a, b):
    return list(df.loc[pd.Timestamp(a, tz="UTC"):pd.Timestamp(b, tz="UTC"), "state"])


def final(sport, league, eid, side):
    d = labels.fetch_summary(sport, league, eid)
    return labels.final_score_check(d, L(sport, league, eid, side).reset_index(), side)


# ----------------------------------------------------------------- NFL / CFB
def test_nfl_hou_at_jax():
    g = ("football", "nfl", "401872996")  # HOU @ JAX, 2026-10-18, HOU won 34-31 on a final-second FG
    h, a = L(*g, "home"), L(*g, "away")
    # Stroud 6-yd TD pass to Moreau, wallclock 13:58:17
    assert span(h, "2026-10-18 13:59", "2026-10-18 14:00") == ["them_scored"] * 2
    assert span(a, "2026-10-18 13:59", "2026-10-18 14:00") == ["us_scored"] * 2
    assert at(h, "2026-10-18 14:01") != "them_scored"  # 2-minute window has expired
    # HOU drive reaching the JAX 6 right before that TD = red zone
    assert at(h, "2026-10-18 13:57") == "them_scoring_position"
    assert at(a, "2026-10-18 13:57") == "us_scoring_position"
    # JAX drive to the HOU 5 that ended in an interception (drive result INT)
    assert set(span(h, "2026-10-18 14:13", "2026-10-18 14:16")) == {"us_scoring_position"}
    assert at(h, "2026-10-18 14:17") == "turnover_us"
    assert at(a, "2026-10-18 14:17") == "turnover_them"
    # 60-yd JAX FG at 16:37:12, game-winning HOU FG at 16:48:23
    assert at(h, "2026-10-18 16:38") == "us_scored"
    assert at(h, "2026-10-18 16:49") == "them_scored"
    # halftime (End of Half 15:05:21 -> 2nd-half kickoff 15:20:15)
    assert set(span(h, "2026-10-18 15:06", "2026-10-18 15:20")) == {"stoppage"}
    assert final(*g, "home") and final(*g, "away")


def test_nfl_chi_at_atl():
    g = ("football", "nfl", "401872999")  # CHI @ ATL, CHI won 31-23
    h = L(*g, "home")
    assert at(h, "2026-10-18 17:14") == "them_scored"       # opening CHI TD drive ends 17:13:25
    assert at(h, "2026-10-18 18:04") == "us_scored"         # ATL TD at 18:03:51
    # CHI TD (19:22:45) then ATL fumbles the ensuing kickoff (19:24:53)
    assert span(h, "2026-10-18 19:23", "2026-10-18 19:24") == ["them_scored"] * 2
    assert span(h, "2026-10-18 19:25", "2026-10-18 19:26") == ["turnover_us"] * 2
    assert at(h, "2026-10-18 19:20") == "them_scoring_position"
    assert final(*g, "home")


def test_cfb_osu_at_iu():
    g = ("football", "college-football", "401858488")  # Ohio State @ Indiana, OSU won 19-15
    h = L(*g, "home")
    # OSU QB intercepted at the OSU 7 (17:02:53), Indiana punches it in on the next drive
    assert at(h, "2026-10-17 17:03") == "turnover_them"
    assert at(h, "2026-10-17 17:05") == "us_scored"
    assert at(h, "2026-10-17 17:53") == "them_scored"  # OSU TD with 0:07 left in the half
    assert final(*g, "home")


def test_cfb_fsu_at_mia_bad_wallclock_play():
    g = ("football", "college-football", "401858263")  # one punt-return play is stamped 30 min late
    h = L(*g, "home")
    # without the outlier repair the whole 00:22-00:50 stretch was 'stoppage'
    assert span(h, "2026-10-18 00:30", "2026-10-18 00:32").count("stoppage") < 3
    assert final(*g, "home")


# ----------------------------------------------------------------- Soccer
def test_epl_forest_arsenal():
    g = ("soccer", "eng.1", "401878769")  # Nottingham Forest 0-1 Arsenal (Madueke 80', 17:09:42)
    h, a = L(*g, "home"), L(*g, "away")
    assert span(h, "2026-10-18 17:10", "2026-10-18 17:11") == ["them_scored"] * 2
    assert span(a, "2026-10-18 17:10", "2026-10-18 17:11") == ["us_scored"] * 2
    assert set(span(h, "2026-10-18 16:20", "2026-10-18 16:35")) == {"halftime"}  # 16:19:36 -> 16:35:11
    assert final(*g, "home")


def test_epl_brentford_liverpool_red_cards():
    g = ("soccer", "eng.1", "401879262")  # Brentford 1-2 Liverpool, two Brentford red cards
    h = L(*g, "home")
    assert span(h, "2026-10-17 14:44", "2026-10-17 14:45") == ["us_scored"] * 2  # header at 14:44:00
    assert span(h, "2026-10-17 14:53", "2026-10-17 14:55") == ["red_card_us"] * 3  # straight red 14:52:31
    assert at(h, "2026-10-17 15:30") == "them_scored"                                # 15:29:10
    assert at(h, "2026-10-17 16:00") == "red_card_us"                                # 2nd yellow 15:59:02
    assert at(L(*g, "away"), "2026-10-17 16:00") == "red_card_them"
    assert final(*g, "home")


def test_epl_brighton_own_goal():
    g = ("soccer", "eng.1", "401879261")  # Brighton 5-0 Crystal Palace; 1-0 is a Palace own goal (13:03:53)
    h = L(*g, "home")
    assert at(h, "2026-10-18 13:04") == "us_scored"
    assert at(L(*g, "away"), "2026-10-18 13:04") == "them_scored"
    assert final(*g, "home")


def test_soccer_pressing_rule():
    g = ("soccer", "eng.1", "401878769")
    a = L(*g, "away")
    # Arsenal corner 15:55:13 + blocked shot 15:55:57 (+ corner 15:57:46); Forest's last attempt was 15:48:40
    assert span(a, "2026-10-18 15:56", "2026-10-18 15:59") == ["us_pressing"] * 4
    assert at(L(*g, "home"), "2026-10-18 15:56") == "them_pressing"
    # 16:54-16:57: Arsenal corners/shot but also a Forest shot (16:53:08) and corner (16:57:29) -> open
    assert span(a, "2026-10-18 16:56", "2026-10-18 16:58") == ["open"] * 3


def test_soccer_without_wallclock_is_skipped():
    df = labels.labels_for("soccer", "eng.1", "704518", "home")  # Feb 2025 EPL: no usable wallclocks
    assert df.empty and df.attrs["quality"]["ok"] is False


# ----------------------------------------------------------------- MLB
def test_mlb_tb_at_cle():
    g = ("baseball", "mlb", "401908027")  # Rays @ Guardians, ALCS G7
    h = L(*g, "home")
    assert at(h, "2026-10-18 00:12") == "them_batting"
    assert at(h, "2026-10-18 00:15") == "between_innings"   # Mid 1st: 00:13:27 -> 00:16:22
    assert at(h, "2026-10-18 00:18") == "us_batting"         # Kwan singles (runner on 1st only)
    assert at(h, "2026-10-18 00:20") == "us_batting_risp"    # Kwan to 2nd on wild pitch 00:19:13
    assert span(h, "2026-10-18 00:25", "2026-10-18 00:26") == ["us_scored"] * 2  # DeLauter RBI single 00:24:16
    assert at(h, "2026-10-18 00:47") == "them_batting_risp"  # Diaz doubled (00:46:19)
    assert at(h, "2026-10-18 00:48") == "them_scored"        # Aranda RBI single 00:47:23
    assert final(*g, "home") and final(*g, "away")


def test_mlb_mil_at_lad():
    g = ("baseball", "mlb", "401908033")  # Brewers @ Dodgers
    h = L(*g, "home")
    assert at(h, "2026-10-16 00:46") == "us_scored"   # Pages RBI single 00:45:01
    assert at(h, "2026-10-16 00:49") == "us_scored"   # Ohtani 3-run HR 00:48:08
    assert at(h, "2026-10-16 02:05") == "them_scored"  # Mitchell HR 02:04:31
    assert at(h, "2026-10-16 00:16") == "between_innings"
    assert final(*g, "home")


# ----------------------------------------------------------------- NHL
def test_nhl_cbj_at_min():
    g = ("hockey", "nhl", "401892533")  # Blue Jackets @ Wild, MIN won 2-1
    h, a = L(*g, "home"), L(*g, "away")
    assert at(h, "2026-10-18 22:13") == "us_power_play"     # CBJ holding minor 22:12:03
    assert at(h, "2026-10-18 22:22") == "them_power_play"   # MIN tripping minor 22:21:45
    assert at(h, "2026-10-18 22:43") == "us_scored"         # Yurov 22:42:05
    assert span(h, "2026-10-18 22:44", "2026-10-18 22:45") == ["them_scored"] * 2  # Fantilli 22:43:54
    assert at(a, "2026-10-18 22:44") == "us_scored"
    assert set(span(h, "2026-10-18 22:47", "2026-10-18 23:04")) == {"intermission"}
    assert at(h, "2026-10-18 23:08") == "us_power_play"     # CBJ high-sticking 23:06:46
    assert at(h, "2026-10-18 23:09") == "us_scored"         # Kaprizov PP goal 23:08:55
    assert final(*g, "home")


def test_nhl_buf_at_mtl():
    g = ("hockey", "nhl", "401892524")  # Sabres @ Canadiens, MTL won 4-3 in OT
    h = L(*g, "home")
    assert at(h, "2026-10-18 00:26") == "them_power_play"   # MTL interference 00:24:28
    assert at(h, "2026-10-18 00:27") == "even"              # BUF minor 00:26:18 -> 4-on-4
    assert at(h, "2026-10-18 00:30") == "them_scored"       # Quinn goal 00:29:35
    assert at(h, "2026-10-18 01:48") == "us_scored"         # OT winner
    assert final(*g, "home")


# ----------------------------------------------------------------- NBA
def test_nba_sas_at_okc():
    g = ("basketball", "nba", "401873198")  # Spurs @ Thunder, WCF 2026
    a = L(*g, "away")
    assert at(a, "2026-05-21 00:42") == "lead_change"            # Wembanyama 3 -> SAS 8-7 at 00:41:14
    assert set(span(a, "2026-05-21 01:07", "2026-05-21 01:09")) == {"break"}  # end Q1 01:06:13 -> 01:09:56
    assert final(*g, "away")


def test_nba_sa_at_ny():
    g = ("basketball", "nba", "401859966")  # Spurs @ Knicks, Finals 2026, NY won 107-106
    h = L(*g, "home")
    assert at(h, "2026-06-11 03:21") == "us_run"         # NY 95-99 -> 103-104 inside 3 min
    assert at(h, "2026-06-11 03:23") == "lead_change"    # NY takes a 105-104 lead
    assert at(h, "2026-06-11 03:28") == "lead_change"    # SA back ahead 106-105
    assert at(h, "2026-06-11 03:33") == "lead_change"    # NY go-ahead 107-106 with 1.2 left
    assert at(L(*g, "away"), "2026-06-11 03:21") == "them_run"
    assert final(*g, "home")


def test_classes_are_valid():
    for (s, l, e, side) in list(_cache):
        assert set(_cache[(s, l, e, side)].state) <= set(labels.SPORT_CLASSES[s])


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    fns.sort(key=lambda f: f.__name__ == "test_classes_are_valid")
    bad = 0
    for f in fns:
        try:
            f()
            print("ok  ", f.__name__)
        except AssertionError as exc:
            bad += 1
            print("FAIL", f.__name__, exc)
    sys.exit(1 if bad else 0)
