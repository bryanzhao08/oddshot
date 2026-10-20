"""Normalize ESPN soccer commentary and build strictly past-only live features."""
from __future__ import annotations

import json
import re
from bisect import bisect_right
from pathlib import Path
import pandas as pd

RAW = Path(__file__).resolve().parent / 'data' / 'raw' / 'soccer'
FEATURES = [
    'minute','is_home','goal_diff','goals_us','goals_them','red_us','red_them',
    'shots_us','shots_them','sot_us','sot_them','corners_us','corners_them',
    'shots_us_10','shots_them_10','sot_us_10','sot_them_10','corners_us_10','corners_them_10',
    'shots_us_5','sot_us_5','corners_us_5','mins_since_goal','mins_since_our_shot','second_half',
    'box_shots_us_10','box_shots_them_10','close_shots_us_10','box_shots_us','box_shots_them'
]


SHOT_KINDS = ('shot', 'shot_on_target', 'goal')


def shot_zone(text):
    """Where a shot was taken, from ESPN's commentary wording: close / box / out."""
    t = text.casefold()
    if 'very close range' in t or 'six yard box' in t:
        return 'close'
    if 'centre of the box' in t or 'side of the box' in t:
        return 'box'
    return 'out'


def _competitors(summary):
    try:
        comps = summary['header']['competitions'][0]['competitors']
        return {c['homeAway']: c['team']['displayName'] for c in comps if c.get('homeAway') in ('home','away')}
    except (KeyError, IndexError, TypeError):
        return {}


def _match_name(name, names):
    if not name:
        return None
    name = re.sub(r'\s+', ' ', str(name)).strip().casefold()
    for side, official in names.items():
        if name == re.sub(r'\s+', ' ', official).strip().casefold():
            return side
    return None


def normalize(summary):
    """Return one record per feed event; a goal implies a shot and SOT in features."""
    names = _competitors(summary)
    if len(names) != 2:
        return []
    out = []
    seen_play_ids = set()
    for item in summary.get('commentary') or []:
        play = item.get('play') or {}
        typ = str((play.get('type') or {}).get('text') or '').strip().casefold()
        if typ.startswith('own goal'):
            kind = 'goal'
            own = True
        elif typ.startswith('goal') or typ.startswith('penalty - scored'):
            kind = 'goal'; own = False
        elif typ.startswith('shot on target') or typ.startswith('saved'):
            kind = 'shot_on_target'; own = False
        elif typ.startswith('shot'):
            kind = 'shot'; own = False
        elif typ.startswith('corner awarded'):
            kind = 'corner'; own = False
        elif 'red card' in typ:
            kind = 'red'; own = False
        else:
            continue
        try:
            minute = float((item.get('time') or {}).get('value')) / 60.0
        except (TypeError, ValueError):
            continue
        if minute < 0:
            continue
        play_id = play.get('id')
        if play_id and play_id in seen_play_ids:
            continue
        body = str(item.get('text') or play.get('text') or '')
        side = None
        # For corners ESPN play.team identifies the defender who conceded.
        if kind == 'corner':
            m = re.search(r'\bCorner,\s*(.+?)\s*\.', body, flags=re.I)
            if m:
                side = _match_name(m.group(1), names)
            if side is None:
                continue
        if own:
            # ESPN's play.team is the beneficiary on own goals; the text's
            # "Own Goal by ..., Team" names the conceding side.
            side = _match_name((play.get('team') or {}).get('displayName'), names)
            if side is None:
                m = re.search(r'Own Goal by .+?,\s*(.+?)\.', body, flags=re.I)
                conceder = _match_name(m.group(1), names) if m else None
                if conceder:
                    side = 'away' if conceder == 'home' else 'home'
        if side is None and kind == 'goal' and not own:
            for candidate in re.findall(r'\(([^)]+)\)', body):
                side = _match_name(candidate, names)
                if side: break
        if side is None:
            side = _match_name((play.get('team') or {}).get('displayName'), names)
        if side is None:
            for candidate in re.findall(r'\(([^)]+)\)', body):
                side = _match_name(candidate, names)
                if side: break
        if side is None and kind == 'goal':
            m = re.search(r'Goal!\s*(.+?)\s+\d+\s*,\s*(.+?)\s+\d+\s*\.', body, flags=re.I)
            if m:
                # Scoreline alone gives no scorer; use delta only if reliable score history is available.
                pass
        if side is None:
            continue
        if play_id:
            seen_play_ids.add(play_id)
        event = {'min': minute, 'team': side, 'kind': kind}
        if kind in SHOT_KINDS and not own:
            event['zone'] = shot_zone(body)
        out.append(event)
    return sorted(out, key=lambda e: e['min'])


def match_end(summary):
    end = []
    for item in summary.get('commentary') or []:
        typ = str(((item.get('play') or {}).get('type') or {}).get('text') or '').casefold()
        if typ.startswith('end regular time') or typ.startswith('end extra time'):
            try: end.append(float(item['time']['value'])/60)
            except (KeyError, TypeError, ValueError): pass
    return max(end) if end else 90.0


def features(timeline, minute, team):
    us, them = team, 'away' if team == 'home' else 'home'
    past = [e for e in timeline if e['min'] <= minute]
    def count(side, kind, window=None):
        return sum(e['team'] == side and (e['kind'] == kind or (kind == 'shot' and e['kind'] in ('shot_on_target','goal')) or (kind == 'shot_on_target' and e['kind'] == 'goal')) and (window is None or e['min'] > minute-window) for e in past)
    goals_us, goals_them = count(us,'goal'), count(them,'goal')
    goals = [e['min'] for e in past if e['kind'] == 'goal']
    our_shots = [e['min'] for e in past if e['team'] == us and e['kind'] in ('shot','shot_on_target','goal')]
    return {
        'minute': minute, 'is_home': int(us == 'home'), 'goal_diff': goals_us-goals_them,
        'goals_us': goals_us, 'goals_them': goals_them, 'red_us': count(us,'red'), 'red_them': count(them,'red'),
        'shots_us': count(us,'shot'), 'shots_them': count(them,'shot'),
        'sot_us': count(us,'shot_on_target'), 'sot_them': count(them,'shot_on_target'),
        'corners_us': count(us,'corner'), 'corners_them': count(them,'corner'),
        'shots_us_10': count(us,'shot',10), 'shots_them_10': count(them,'shot',10),
        'sot_us_10': count(us,'shot_on_target',10), 'sot_them_10': count(them,'shot_on_target',10),
        'corners_us_10': count(us,'corner',10), 'corners_them_10': count(them,'corner',10),
        'shots_us_5': count(us,'shot',5), 'sot_us_5': count(us,'shot_on_target',5),
        'corners_us_5': count(us,'corner',5),
        'mins_since_goal': minute-max(goals) if goals else minute,
        'mins_since_our_shot': minute-max(our_shots) if our_shots else minute,
        'second_half': int(minute > 45),
        **zone_features(past, us, them, minute),
    }


def zone_features(past, us, them, minute):
    def n(side, zones, window=None):
        return sum(e['team'] == side and e.get('zone') in zones and (window is None or e['min'] > minute-window) for e in past)
    box = ('box', 'close')
    return {'box_shots_us_10': n(us, box, 10), 'box_shots_them_10': n(them, box, 10),
            'close_shots_us_10': n(us, ('close',), 10), 'box_shots_us': n(us, box), 'box_shots_them': n(them, box)}


def _indexed_features(timeline, minute, team, index):
    """Equivalent to features(), with binary searches for batch extraction."""
    us, them = team, 'away' if team == 'home' else 'home'
    def count(side, kind, window=None):
        times = index[(side, kind)]
        end = bisect_right(times, minute)
        return end if window is None else end-bisect_right(times, minute-window)
    goals_us, goals_them = count(us,'goal'), count(them,'goal')
    last_goal_times = index[('any','goal')]
    last_goal_i = bisect_right(last_goal_times, minute)
    our_shots = index[(us,'shot')]
    last_shot_i = bisect_right(our_shots, minute)
    return {
        'minute': minute, 'is_home': int(us == 'home'), 'goal_diff': goals_us-goals_them,
        'goals_us': goals_us, 'goals_them': goals_them, 'red_us': count(us,'red'), 'red_them': count(them,'red'),
        'shots_us': count(us,'shot'), 'shots_them': count(them,'shot'),
        'sot_us': count(us,'shot_on_target'), 'sot_them': count(them,'shot_on_target'),
        'corners_us': count(us,'corner'), 'corners_them': count(them,'corner'),
        'shots_us_10': count(us,'shot',10), 'shots_them_10': count(them,'shot',10),
        'sot_us_10': count(us,'shot_on_target',10), 'sot_them_10': count(them,'shot_on_target',10),
        'corners_us_10': count(us,'corner',10), 'corners_them_10': count(them,'corner',10),
        'shots_us_5': count(us,'shot',5), 'sot_us_5': count(us,'shot_on_target',5),
        'corners_us_5': count(us,'corner',5),
        'mins_since_goal': minute-last_goal_times[last_goal_i-1] if last_goal_i else minute,
        'mins_since_our_shot': minute-our_shots[last_shot_i-1] if last_shot_i else minute,
        'second_half': int(minute > 45),
        'box_shots_us_10': count(us,'box',10), 'box_shots_them_10': count(them,'box',10),
        'close_shots_us_10': count(us,'close',10), 'box_shots_us': count(us,'box'), 'box_shots_them': count(them,'box'),
    }


def _index(timeline):
    index = {(side, kind): [] for side in ('home','away') for kind in ('goal','red','shot','shot_on_target','corner','box','close')}
    index[('any','goal')] = []
    for e in timeline:
        side, kind, minute = e['team'], e['kind'], e['min']
        index[(side,kind)].append(minute)
        if e.get('zone') in ('box', 'close'):
            index[(side,'box')].append(minute)
        if e.get('zone') == 'close':
            index[(side,'close')].append(minute)
        if kind == 'goal':
            index[('any','goal')].append(minute)
            index[(side,'shot')].append(minute)
            index[(side,'shot_on_target')].append(minute)
        elif kind == 'shot_on_target':
            index[(side,'shot')].append(minute)
    return index


def load_soccer(max_games=None):
    rows=[]; samples=[]; seen=set(); game_count=0
    for manifest_path in sorted(RAW.glob('*/*/manifest.json')):
        manifest=json.loads(manifest_path.read_text())
        for event in manifest.get('events',[]):
            gid=str(event['id'])
            if gid in seen: continue
            path=manifest_path.parent/event['summary']
            if not path.exists(): continue
            try: summary=json.loads(path.read_text())
            except (OSError, ValueError): continue
            timeline=normalize(summary)
            if not timeline: continue
            seen.add(gid); game_count+=1
            if len(samples)<2:
                samples.append({'league':manifest['league'],'season':manifest['season'],'event_id':gid,'raw_summary':summary,'expected_timeline':timeline})
            end=match_end(summary)
            index=_index(timeline)
            for t in range(1,89):
                if t >= end: continue
                for team in ('home','away'):
                    x=_indexed_features(timeline,t,team,index)
                    y=int(bisect_right(index[(team,'goal')],t+10)>bisect_right(index[(team,'goal')],t))
                    rows.append({'game_id':gid,'game_date':event['date'],'league':manifest['league'],'match_name':event.get('name',''),'at':t,'team':team,'timeline':timeline,'y':y,**x})
            if max_games and game_count>=max_games: break
        if max_games and game_count>=max_games: break
    if samples:
        dest=Path(__file__).resolve().parents[2]/'server'/'ml'/'sports'/'samples'
        dest.mkdir(parents=True,exist_ok=True)
        for i,s in enumerate(samples,1):
            (dest/f'soccer_{i}.json').write_text(json.dumps(s,separators=(',',':')))
    return pd.DataFrame(rows)
