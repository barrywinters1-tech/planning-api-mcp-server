"""Compare two versions of a programme and explain what changed and why the finish moved.

    compare(old, new) -> dict      structured differences (JSON-serialisable, dates as ISO strings)
    narrative(result) -> str       a deterministic plain-English commentary (UK), no AI

Activities are matched by id. Durations, lags and date shifts are in working days of the
activity's calendar (the predecessor's calendar for lags, the new project's default calendar
for the project finish), rounded to 1 dp with Python's round(). Relationships are keyed by
(predecessor, successor, type), so an SS and an FF between the same pair are two links; a key
present in both versions with a different lag is a change, and a pair with exactly one link on
each side whose type differs is also a change.

The finish explanation walks the NEW programme's driving links back from the activity that
sets the finish (the longest path) and lists the activities on it that changed.

web/compare.js is a line-for-line port and must produce identical output
(tests/test_compare_parity.py).
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from .cpm import schedule
from .model import Activity, ActivityType, Calendar, Project, Status

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
EPS = 1e-9
MAX_DRIVERS = 4   # driver activities named in the narrative
MAX_NAMED = 3     # items named per category in the narrative


# ----------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------
def _r1(x: float) -> float:
    return round(x, 1) + 0.0          # + 0.0 turns -0.0 into 0.0 (JSON has no negative zero)


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.replace(microsecond=0).isoformat() if d is not None else None


def _scheduled(p: Project) -> Project:
    q = p.model_copy(deep=True)
    if q.finish is None or any(a.early_start is None for a in q.activities):
        schedule(q)
    return q


def _default_cal(p: Project) -> Calendar:
    return p.calendars.get(p.default_calendar_id) or Calendar(id=p.default_calendar_id)


def _cal_of(p: Project, amap: dict[str, Activity], aid: str) -> Calendar:
    a = amap.get(aid)
    return p.calendar_for(a) if a is not None else _default_cal(p)


def _days_between(cal: Calendar, a: Optional[datetime], b: Optional[datetime]) -> Optional[float]:
    if a is None or b is None:
        return None
    return _r1(cal.hours_to_days(cal.hours_between(a, b)))


def _cal_sig(c: Calendar) -> dict:
    return {"name": c.name, "hours_per_day": c.hours_per_day, "day_start": c.day_start.strftime("%H:%M"),
            "working_days": sorted(c.working_days), "exceptions": {d.isoformat(): v for d, v in c.exceptions.items()}}


def _calendar_users(p: Project) -> dict[str, int]:
    out: dict[str, int] = {}
    for a in p.activities:
        cid = a.calendar_id or p.default_calendar_id
        out[cid] = out.get(cid, 0) + 1
    return out


def _calendar_changes(o: Project, n: Project) -> list[dict]:
    """Calendar definitions added, removed or changed. used_by counts the activities on that
    calendar (in the new version, or the old one for a removed calendar), so a reader can
    ignore definitions nothing uses (apply_patch adds the standard set to every project)."""
    out = []
    ou, nu = _calendar_users(o), _calendar_users(n)
    for cid in sorted(set(o.calendars) | set(n.calendars)):
        if cid not in o.calendars:
            out.append({"calendar": cid, "change": "added", "used_by": nu.get(cid, 0), "fields": [],
                        "exceptions_added": [], "exceptions_removed": [], "exceptions_changed": []})
            continue
        if cid not in n.calendars:
            out.append({"calendar": cid, "change": "removed", "used_by": ou.get(cid, 0), "fields": [],
                        "exceptions_added": [], "exceptions_removed": [], "exceptions_changed": []})
            continue
        a, b = _cal_sig(o.calendars[cid]), _cal_sig(n.calendars[cid])
        fields = [f for f in ("name", "hours_per_day", "day_start", "working_days") if a[f] != b[f]]
        ea, eb = a["exceptions"], b["exceptions"]
        added = sorted(k for k in eb if k not in ea)
        removed = sorted(k for k in ea if k not in eb)
        changed = sorted(k for k in eb if k in ea and ea[k] != eb[k])
        if added or removed or changed:
            fields.append("exceptions")
        if fields:
            out.append({"calendar": cid, "change": "changed", "used_by": nu.get(cid, 0), "fields": fields, "exceptions_added": added,
                        "exceptions_removed": removed, "exceptions_changed": changed})
    return out


def _rel_index(p: Project) -> dict:
    out: dict = {}
    for r in p.relationships:
        out.setdefault((r.predecessor_id, r.successor_id, r.type.value), r)   # first link wins on duplicates
    return out


def _walk_driving(p: Project) -> tuple[Optional[Activity], set[str]]:
    """Activities on the driving chain(s) back from the activity that sets the finish."""
    amap = p.activity_map()
    open_ = [a for a in p.activities if a.status != Status.COMPLETE and a.type != ActivityType.LOE and a.early_finish is not None]
    if not open_:
        return None, set()
    end = max(a.early_finish for a in open_)
    ends = [a for a in open_ if a.early_finish == end]
    tied = {a.id for a in ends}
    feeding = {r.predecessor_id for r in p.relationships if r.successor_id in tied and r.predecessor_id in tied}
    finish_act = next((a for a in ends if a.id not in feeding), ends[0])   # e.g. the finish milestone, not the task feeding it
    preds: dict[str, list] = {}
    for r in p.relationships:
        preds.setdefault(r.successor_id, []).append(r)
    seen: set[str] = set()
    stack = [a.id for a in ends]
    while stack:
        aid = stack.pop()
        if aid in seen:
            continue
        seen.add(aid)
        for r in preds.get(aid, []):
            q = amap.get(r.predecessor_id)
            if r.driving and q is not None and q.type != ActivityType.LOE:
                stack.append(q.id)
    return finish_act, seen


# ----------------------------------------------------------------------------------------
# compare
# ----------------------------------------------------------------------------------------
def compare(old: Project, new: Project) -> dict:
    o, n = _scheduled(old), _scheduled(new)
    calendar_changes = _calendar_changes(o, n)
    om, nm = o.activity_map(), n.activity_map()
    ocal, ncal = _default_cal(o), _default_cal(n)

    added = [{"id": a.id, "name": a.name} for a in n.activities if a.id not in om]
    removed = [{"id": a.id, "name": a.name} for a in o.activities if a.id not in nm]
    renamed, duration_changes, date_moves, constraint_changes, progress_changes, cal_moves = [], [], [], [], [], []
    shifts: dict[str, tuple] = {}

    for na in n.activities:
        oa = om.get(na.id)
        if oa is None:
            continue
        cal, oc = n.calendar_for(na), o.calendar_for(oa)
        if oa.name != na.name:
            renamed.append({"id": na.id, "old": oa.name, "new": na.name})
        if ActivityType.LOE not in (oa.type, na.type):
            od, nd = oc.hours_to_days(oa.duration_hours), cal.hours_to_days(na.duration_hours)
            if abs(nd - od) > EPS:
                duration_changes.append({"id": na.id, "name": na.name, "old_days": _r1(od), "new_days": _r1(nd), "delta_days": _r1(nd - od)})
        ocid, ncid = oa.calendar_id or o.default_calendar_id, na.calendar_id or n.default_calendar_id
        if ocid != ncid:
            cal_moves.append({"id": na.id, "name": na.name, "old": ocid, "new": ncid})
        ocon = {"type": oa.constraint.value, "date": _iso(oa.constraint_date)}
        ncon = {"type": na.constraint.value, "date": _iso(na.constraint_date)}
        if ocon != ncon:
            constraint_changes.append({"id": na.id, "name": na.name, "old": ocon, "new": ncon})
        if (oa.status != na.status or abs(oa.percent_complete - na.percent_complete) > EPS
                or oa.actual_start != na.actual_start or oa.actual_finish != na.actual_finish):
            progress_changes.append({"id": na.id, "name": na.name, "old_status": oa.status.value, "new_status": na.status.value,
                                     "old_pct": _r1(oa.percent_complete), "new_pct": _r1(na.percent_complete),
                                     "old_actual_start": _iso(oa.actual_start), "new_actual_start": _iso(na.actual_start),
                                     "old_actual_finish": _iso(oa.actual_finish), "new_actual_finish": _iso(na.actual_finish)})
        ss, fs = _days_between(cal, oa.start, na.start), _days_between(cal, oa.finish, na.finish)
        shifts[na.id] = (ss, fs)
        if oa.start != na.start or oa.finish != na.finish:
            date_moves.append({"id": na.id, "name": na.name, "start_shift_days": ss, "finish_shift_days": fs,
                               "old_start": _iso(oa.start), "new_start": _iso(na.start),
                               "old_finish": _iso(oa.finish), "new_finish": _iso(na.finish)})
    date_moves.sort(key=lambda m: (-abs(m["finish_shift_days"] or 0.0), m["id"]))

    # ---- logic ----
    oi, ni = _rel_index(o), _rel_index(n)

    def lag(p, amap, r):
        return _r1(_cal_of(p, amap, r.predecessor_id).hours_to_days(r.lag_hours))

    o_only = [k for k in oi if k not in ni]
    n_only = [k for k in ni if k not in oi]
    o_pairs: dict[tuple, list] = {}
    n_pairs: dict[tuple, list] = {}
    for k in o_only:
        o_pairs.setdefault(k[:2], []).append(k)
    for k in n_only:
        n_pairs.setdefault(k[:2], []).append(k)
    logic_added, logic_removed, logic_changed = [], [], []
    consumed: set = set()
    for k, nr in ni.items():
        if k in oi:
            orr = oi[k]
            if abs(orr.lag_hours - nr.lag_hours) > 1e-6:
                logic_changed.append({"pred": k[0], "succ": k[1], "old_type": k[2], "new_type": k[2],
                                      "old_lag_days": lag(o, om, orr), "new_lag_days": lag(n, nm, nr)})
        elif len(n_pairs[k[:2]]) == 1 and len(o_pairs.get(k[:2], [])) == 1:
            ok = o_pairs[k[:2]][0]
            consumed.add(ok)
            logic_changed.append({"pred": k[0], "succ": k[1], "old_type": ok[2], "new_type": k[2],
                                  "old_lag_days": lag(o, om, oi[ok]), "new_lag_days": lag(n, nm, nr)})
        else:
            logic_added.append({"pred": k[0], "succ": k[1], "type": k[2], "lag_days": lag(n, nm, nr)})
    for k in o_only:
        if k not in consumed:
            logic_removed.append({"pred": k[0], "succ": k[1], "type": k[2], "lag_days": lag(o, om, oi[k])})

    # ---- critical path ----
    oc_ids = {a.id for a in o.activities if a.critical}
    nc_ids = {a.id for a in n.activities if a.critical}
    joined = [a.id for a in n.activities if a.critical and a.id not in oc_ids]
    left = [a.id for a in o.activities if a.critical and a.id not in nc_ids]

    # ---- finish drivers: changed activities on the driving chain ----
    def changes_for(aid: str, in_old: bool, in_new: bool) -> list[dict]:
        ch: list[dict] = []
        if not in_old:
            ch.append({"kind": "added"})
        if not in_new:
            ch.append({"kind": "removed"})
        for d in duration_changes:
            if d["id"] == aid:
                ch.append({"kind": "duration", "old_days": d["old_days"], "new_days": d["new_days"], "delta_days": d["delta_days"]})
        for kind, lst in (("logic_added", logic_added), ("logic_changed", logic_changed), ("logic_removed", logic_removed)):
            for l in lst:
                if l["succ"] == aid:
                    ch.append({"kind": kind, **l})
        for c in constraint_changes:
            if c["id"] == aid:
                ch.append({"kind": "constraint", "old": c["old"], "new": c["new"]})
        for c in progress_changes:
            if c["id"] == aid:
                ch.append({"kind": "progress", "old_status": c["old_status"], "new_status": c["new_status"],
                           "old_pct": c["old_pct"], "new_pct": c["new_pct"]})
        for c in cal_moves:
            if c["id"] == aid:
                ch.append({"kind": "calendar", "old": c["old"], "new": c["new"]})
        return ch

    def chain_changes(p: Project, is_new: bool) -> tuple[Optional[Activity], list[dict]]:
        end, ids = _walk_driving(p)
        items = []
        for a in p.activities:
            if a.id not in ids:
                continue
            ch = changes_for(a.id, a.id in om if is_new else True, True if is_new else a.id in nm)
            if ch:
                ss, fs = shifts.get(a.id, (None, None))
                items.append({"id": a.id, "name": a.name, "start": _iso(a.start), "start_shift_days": ss,
                              "finish_shift_days": fs, "changes": ch})
        items.sort(key=lambda x: (x["start"] or "", x["id"]))
        return end, items

    fin_act, finish_drivers = chain_changes(n, True)
    _, former_path_changes = chain_changes(o, False)

    def margin(p: Project, cal: Calendar) -> Optional[float]:
        return _days_between(cal, p.finish, p.must_finish_by) if p.must_finish_by is not None else None

    counts = {"added": len(added), "removed": len(removed), "renamed": len(renamed), "duration_changes": len(duration_changes),
              "date_moves": len(date_moves), "logic_added": len(logic_added), "logic_removed": len(logic_removed),
              "logic_changed": len(logic_changed), "constraint_changes": len(constraint_changes),
              "progress_changes": len(progress_changes), "calendar_changes": len(calendar_changes) + len(cal_moves),
              "critical_joined": len(joined), "critical_left": len(left)}
    summary = {
        "old_start": _iso(o.start), "new_start": _iso(n.start),
        "old_finish": _iso(o.finish), "new_finish": _iso(n.finish),
        "finish_shift_days": _days_between(ncal, o.finish, n.finish),
        "old_must_finish_by": _iso(o.must_finish_by), "new_must_finish_by": _iso(n.must_finish_by),
        "old_margin_days": margin(o, ocal), "new_margin_days": margin(n, ncal),
        "finish_activity_id": fin_act.id if fin_act else None,
        "finish_activity_name": fin_act.name if fin_act else None,
        "critical_path_changed": bool(joined or left),
        "counts": counts,
    }
    return {
        "summary": summary,
        "added": added, "removed": removed, "renamed": renamed,
        "duration_changes": duration_changes, "date_moves": date_moves,
        "logic_added": logic_added, "logic_removed": logic_removed, "logic_changed": logic_changed,
        "constraint_changes": constraint_changes, "progress_changes": progress_changes,
        "calendar_changes": {"calendars": calendar_changes, "activities": cal_moves},
        "data_date": {"old": _iso(o.data_date), "new": _iso(n.data_date)},
        "critical": {"joined": joined, "left": left},
        "finish_drivers": finish_drivers,
        "former_path_changes": former_path_changes,
    }


# ----------------------------------------------------------------------------------------
# narrative
# ----------------------------------------------------------------------------------------
def _d(iso: str) -> str:
    return f"{int(iso[8:10])} {MONTHS[int(iso[5:7]) - 1]} {int(iso[:4])}"


def _n(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else f"{x:.1f}"


def _s(x: float) -> str:
    return ("+" if x > 0 else "") + _n(x)


def _count(k: int, one: str, many: str) -> str:
    return f"{k} {one if k == 1 else many}"


def _wd(x: float) -> str:
    return _count_n(abs(x), "working day", "working days")


def _count_n(x: float, one: str, many: str) -> str:
    return f"{_n(x)} {one if x == 1 else many}"


def _and(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _top(items: list[str]) -> str:
    more = len(items) - MAX_NAMED
    return ", ".join(items[:MAX_NAMED]) + (f" and {more} more" if more > 0 else "")


def _link(t: str, lag: float) -> str:
    return t + (_s(lag) + "d" if lag else "")


def _cons(c: dict) -> str:
    if c["type"] == "none":
        return "none"
    t = c["type"].replace("_", " ")
    return t + (" " + _d(c["date"]) if c["date"] else "")


def _change_text(c: dict) -> str:
    k = c["kind"]
    if k == "added":
        return "new activity"
    if k == "removed":
        return "since removed"
    if k == "duration":
        return f"{_s(c['delta_days'])}d duration"
    if k == "logic_added":
        extra = "" if c["type"] == "FS" and not c["lag_days"] else " " + _link(c["type"], c["lag_days"])
        return f"new link {c['pred']}→{c['succ']}{extra}"
    if k == "logic_removed":
        return f"link {c['pred']}→{c['succ']} removed"
    if k == "logic_changed":
        return f"link {c['pred']}→{c['succ']} now {_link(c['new_type'], c['new_lag_days'])}, was {_link(c['old_type'], c['old_lag_days'])}"
    if k == "constraint":
        if c["new"]["type"] == "none":
            return f"constraint removed, was {_cons(c['old'])}"
        return f"constraint now {_cons(c['new'])}"
    if k == "progress":
        if c["new_status"] != c["old_status"]:
            if c["new_status"] == "complete":
                return "now complete"
            if c["new_status"] == "in_progress":
                return f"started, {_n(c['new_pct'])}% complete"
            return "progress removed"
        if c["new_pct"] != c["old_pct"]:
            return f"progress {_n(c['old_pct'])}% to {_n(c['new_pct'])}%"
        return "actual dates revised"
    return f"calendar {c['old']} to {c['new']}"


def _item_text(it: dict) -> str:
    return f"{it['id']} {it['name']} (" + "; ".join(_change_text(c) for c in it["changes"]) + ")"


def _pick(items: list[dict], shift: Optional[float]) -> list[dict]:
    """Up to MAX_DRIVERS items, kept in chain order. When the finish moved, prefer the activities
    that moved the same way (or are new), since those are the ones pushing or pulling it."""
    sign = 1 if (shift or 0.0) > 0 else -1 if (shift or 0.0) < 0 else 0
    first = [i for i, it in enumerate(items) if sign and (it["finish_shift_days"] is None or it["finish_shift_days"] * sign > 0)]
    rest = [i for i in range(len(items)) if i not in first]
    return [items[i] for i in sorted((first + rest)[:MAX_DRIVERS])]


def narrative(result: dict) -> str:
    s, cnt = result["summary"], result["summary"]["counts"]
    dd = result["data_date"]
    moved = s["old_finish"] != s["new_finish"]
    cc = result["calendar_changes"]
    cal_items = ([c["calendar"] + " " + c["change"] for c in cc["calendars"] if c["used_by"]]
                 + [c["id"] + " to " + c["new"] for c in cc["activities"]])
    quiet = ("date_moves", "critical_joined", "critical_left", "calendar_changes")
    nothing = (all(v == 0 for k, v in cnt.items() if k not in quiet) and not cal_items and dd["old"] == dd["new"]
               and s["old_start"] == s["new_start"] and s["old_must_finish_by"] == s["new_must_finish_by"])
    paras: list[str] = []

    # ---- headline ----
    head: list[str] = []
    if not moved:
        if nothing:
            head.append(f"The programme is unchanged between the two versions. Forecast completion remains {_d(s['new_finish'])}.")
        else:
            head.append(f"Forecast completion is unchanged at {_d(s['new_finish'])}.")
    else:
        fs = s["finish_shift_days"] or 0.0
        if fs == 0:
            head.append(f"Forecast completion has moved from {_d(s['old_finish'])} to {_d(s['new_finish'])}, by less than a tenth of a working day.")
        else:
            head.append(f"Forecast completion has moved {'later' if fs > 0 else 'earlier'} by {_wd(fs)}, "
                        f"from {_d(s['old_finish'])} to {_d(s['new_finish'])}.")
    omfb, nmfb = s["old_must_finish_by"], s["new_must_finish_by"]
    if nmfb:
        what = f"the required completion date of {_d(nmfb)}"
        if omfb != nmfb:
            head.append(f"The required completion date moved from {_d(omfb)} to {_d(nmfb)}." if omfb
                        else f"A required completion date of {_d(nmfb)} has been set.")
            what = "it"
        m = s["new_margin_days"]
        if m > 0:
            txt = f"The forecast is {_wd(m)} ahead of {what}"
        elif m < 0:
            txt = f"The forecast is {_wd(m)} behind {what}"
        else:
            txt = f"The forecast meets {what}"
        om_ = s["old_margin_days"]
        if omfb == nmfb and om_ is not None and om_ != m:
            txt += (f", previously {_wd(om_)} {'ahead' if om_ > 0 else 'behind'}" if om_ != 0 else ", previously on the date")
        head.append(txt + ".")
    elif omfb:
        head.append(f"The required completion date of {_d(omfb)} has been removed.")
    paras.append(" ".join(head))

    # ---- drivers on the longest path ----
    drv: list[str] = []
    fd = result["finish_drivers"]
    if fd:
        named = _and([_item_text(it) for it in _pick(fd, s["finish_shift_days"] if moved else 0.0)])
        target = f"{s['finish_activity_id']} {s['finish_activity_name']}"
        if moved:
            drv.append(f"On the longest path to {target}, the movement is driven by {named}.")
        else:
            drv.append(f"Changes on the longest path to {target}: {named}.")
        if len(fd) > MAX_DRIVERS:
            k = len(fd) - MAX_DRIVERS
            drv.append(f"{_count(k, 'further changed activity lies', 'further changed activities lie')} on that path.")
    elif moved:
        fp = result["former_path_changes"]
        if fp:
            drv.append("No changed activity lies on the new longest path; the former longest path changed at "
                       + _and([_item_text(it) for it in _pick(fp, 0.0)]) + ".")
        elif s["old_start"] != s["new_start"]:
            drv.append(f"No changed activity lies on the longest path; the movement follows the project start moving from {_d(s['old_start'])} to {_d(s['new_start'])}.")
        elif dd["old"] != dd["new"] and dd["old"] and dd["new"]:
            drv.append(f"No changed activity lies on the longest path; the movement follows the data date moving from {_d(dd['old'])} to {_d(dd['new'])}.")
        else:
            drv.append("No changed activity lies on the longest path; the movement comes from changes elsewhere in the programme.")
    if s["critical_path_changed"]:
        cr, parts = result["critical"], []
        if cr["joined"]:
            parts.append(f"{_count(len(cr['joined']), 'activity', 'activities')} joined ({_top(cr['joined'])})")
        if cr["left"]:
            parts.append(f"{_count(len(cr['left']), 'activity', 'activities')} left ({_top(cr['left'])})")
        drv.append("The critical path has changed: " + " and ".join(parts) + ".")
    if drv:
        paras.append(" ".join(drv))

    # ---- everything else ----
    parts = []
    if result["added"]:
        parts.append(f"{_count(len(result['added']), 'activity', 'activities')} added ({_top([x['id'] + ' ' + x['name'] for x in result['added']])})")
    if result["removed"]:
        parts.append(f"{_count(len(result['removed']), 'activity', 'activities')} removed ({_top([x['id'] + ' ' + x['name'] for x in result['removed']])})")
    if result["renamed"]:
        parts.append(f"{len(result['renamed'])} renamed ({_top([x['id'] for x in result['renamed']])})")
    if result["duration_changes"]:
        parts.append(f"{_count(len(result['duration_changes']), 'duration', 'durations')} changed "
                     f"({_top([x['id'] + ' ' + _s(x['delta_days']) + 'd' for x in result['duration_changes']])})")
    logic = []
    for key, verb in (("logic_added", "added"), ("logic_removed", "removed"), ("logic_changed", "changed")):
        if result[key]:
            logic.append(f"{_count(len(result[key]), 'link', 'links')} {verb}")
    if logic:
        parts.append(_and(logic))
    if result["constraint_changes"]:
        parts.append(f"{_count(len(result['constraint_changes']), 'constraint', 'constraints')} changed "
                     f"({_top([x['id'] for x in result['constraint_changes']])})")
    if result["progress_changes"]:
        parts.append(f"progress updated on {_count(len(result['progress_changes']), 'activity', 'activities')} "
                     f"({_top([x['id'] + ' ' + _n(x['new_pct']) + '%' for x in result['progress_changes']])})")
    if cal_items:
        parts.append(f"{_count(len(cal_items), 'calendar change', 'calendar changes')} ({_top(cal_items)})")
    if dd["old"] != dd["new"]:
        if dd["old"] and dd["new"]:
            parts.append(f"the data date moved from {_d(dd['old'])} to {_d(dd['new'])}")
        elif dd["new"]:
            parts.append(f"a data date of {_d(dd['new'])} was set")
        else:
            parts.append("the data date was cleared")
    if s["old_start"] != s["new_start"]:
        parts.append(f"the project start moved from {_d(s['old_start'])} to {_d(s['new_start'])}")
    if result["date_moves"]:
        parts.append(f"{_count(len(result['date_moves']), 'activity has', 'activities have')} moved in date")
    if parts:
        paras.append("Across the programme: " + "; ".join(parts) + ".")
    return "\n\n".join(paras)
