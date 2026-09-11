"""A small command language for changing a schedule. Pure parsing, no AI.

    add 2 weeks to A1240              extend A1240 by 10 days
    shorten A1240 by 3d               reduce
    set A1240 to 15d                  absolute duration
    link A1010 -> A1020 SS+2d         add or replace a link
    unlink A1010 A1020
    rename A1010 Excavate strip foundations
    delete A1045
    insert "Scaffold lift" 3d after A1040 before A1050
    start 2026-05-04                  move the project start
    finish by 1 Nov 2026              set must-finish-by
    constrain A1100 start on or after 16 Mar 2026
    unconstrain A1100
    progress A1010 50% as of 20 Apr 2026
    complete A1010 on 24 Apr 2026
    data date 2026-04-20
    assign A1020 Piling gang
    fix                               run the DCMA repairer
    help
"""
from __future__ import annotations

import re
from datetime import date
from typing import Optional

from .generator import _find_dates
from .model import Project
from .plan import Patch, PatchOp

HELP = __doc__.split("\n", 2)[2]


class CommandError(ValueError):
    pass


def _date(text: str) -> Optional[str]:
    found = _find_dates(text)
    if found:
        return found[0][1].isoformat()
    m = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b", text)
    if m:
        y = int(m[3]) + (2000 if int(m[3]) < 100 else 0)
        return date(y, int(m[2]), int(m[1])).isoformat()
    return None


def _days(text: str) -> Optional[float]:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(w|wk|wks|week|weeks|d|day|days|h|hr|hrs|hour|hours|m|mo|month|months)?\b", text)
    if not m:
        return None
    n, u = float(m[1]), (m[2] or "d")[0]
    return n * 5 if u == "w" else n / 8 if u == "h" else n * 21 if u == "m" else n


def _resolve(project: Project, token: str) -> str:
    token = token.strip().strip("\"'")
    ids = {a.id.lower(): a.id for a in project.activities}
    if token.lower() in ids:
        return ids[token.lower()]
    hits = [a for a in project.activities if token.lower() in a.name.lower()]
    if len(hits) == 1:
        return hits[0].id
    if not hits:
        raise CommandError(f"No activity matches '{token}'.")
    raise CommandError(f"'{token}' matches {len(hits)} activities: " + ", ".join(f"{a.id} {a.name}" for a in hits[:5]))


def parse_command(project: Project, text: str) -> Patch:
    t = text.strip()
    low = t.lower()
    ops: list[PatchOp] = []
    ID = r"(\"[^\"]+\"|'[^']+'|[A-Za-z][A-Za-z0-9_.-]*\d[A-Za-z0-9_.-]*|[A-Za-z][A-Za-z ]{2,40}?)"

    if low in ("help", "?"):
        return Patch(ops=[], message=HELP)
    if low in ("fix", "repair", "fix it", "fix the failing checks"):
        return Patch(ops=[PatchOp(op="note", reason="__repair__")], message="repair")

    m = re.match(r"(add|extend|push|delay)\s+(.+?)\s+(?:to|on)\s+" + ID + r"\s*$", t, re.I) or \
        re.match(r"(extend|add to|lengthen)\s+" + ID + r"\s+by\s+(.+)$", t, re.I)
    if m:
        g = m.groups()
        amount, aid = (g[1], g[2]) if g[0].lower() in ("add", "extend", "push", "delay") and len(g) == 3 and re.search(r"\d", g[1]) else (g[2], g[1])
        aid = _resolve(project, aid)
        a = project.activity(aid)
        cal = project.calendar_for(a)
        d = _days(amount)
        if d is None:
            raise CommandError("How much? e.g. 'add 2 weeks to A1240'")
        new = cal.hours_to_days(a.duration_hours) + d
        ops.append(PatchOp(op="set_duration", activity_id=aid, duration_days=new, reason=f"{t}"))
        return Patch(ops=ops, message=f"{aid} {a.name}: {cal.hours_to_days(a.duration_hours):g}d → {new:g}d.")

    m = re.match(r"(shorten|reduce|cut|shrink)\s+" + ID + r"\s+by\s+(.+)$", t, re.I)
    if m:
        aid = _resolve(project, m[2])
        a = project.activity(aid)
        cal = project.calendar_for(a)
        d = _days(m[3]) or 0
        new = max(0.5, cal.hours_to_days(a.duration_hours) - d)
        ops.append(PatchOp(op="set_duration", activity_id=aid, duration_days=new, reason=t))
        return Patch(ops=ops, message=f"{aid} {a.name}: {cal.hours_to_days(a.duration_hours):g}d → {new:g}d.")

    m = re.match(r"(?:set\s+)?" + ID + r"\s*(?:=|to|duration)\s*(\d+(?:\.\d+)?\s*[a-z]*)\s*$", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        d = _days(m[2])
        ops.append(PatchOp(op="set_duration", activity_id=aid, duration_days=d, reason=t))
        return Patch(ops=ops, message=f"{aid} duration set to {d:g}d.")

    m = re.match(r"link\s+" + ID + r"\s*(?:->|to|→)\s*" + ID + r"\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+(?:\.\d+)?\s*[a-z]*)?\s*$", t, re.I)
    if m:
        p, s = _resolve(project, m[1]), _resolve(project, m[2])
        lag = 0.0
        if m[4]:
            lag = (_days(m[4].replace(" ", "")[1:]) or 0) * (-1 if m[4].strip().startswith("-") else 1)
        ops.append(PatchOp(op="add_link", predecessor_id=p, successor_id=s, link_type=(m[3] or "FS").upper(), lag_days=lag, reason=t))
        return Patch(ops=ops, message=f"Linked {p} {(m[3] or 'FS').upper()}{'%+g' % lag + 'd' if lag else ''} {s}.")

    m = re.match(r"unlink\s+" + ID + r"\s*(?:->|to|from|→|,)?\s*" + ID + r"\s*$", t, re.I)
    if m:
        p, s = _resolve(project, m[1]), _resolve(project, m[2])
        ops.append(PatchOp(op="remove_link", predecessor_id=p, successor_id=s, reason=t))
        ops.append(PatchOp(op="remove_link", predecessor_id=s, successor_id=p, reason=t))
        return Patch(ops=ops, message=f"Removed links between {p} and {s}.")

    m = re.match(r"rename\s+" + ID + r"\s+(?:to\s+)?(.+)$", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        ops.append(PatchOp(op="rename", activity_id=aid, name=m[2].strip().strip("\"'"), reason=t))
        return Patch(ops=ops, message=f"Renamed {aid}.")

    m = re.match(r"(delete|remove)\s+" + ID + r"\s*$", t, re.I)
    if m:
        aid = _resolve(project, m[2])
        ops.append(PatchOp(op="remove_activity", activity_id=aid, reason=t))
        return Patch(ops=ops, message=f"Removed {aid}; predecessors were linked straight to successors.")

    m = re.match(r"(?:insert|add activity|new)\s+[\"'](.+?)[\"']\s+(\d+(?:\.\d+)?\s*[a-z]*)\s*(?:after\s+" + ID + r")?\s*(?:before\s+" + ID + r")?\s*$", t, re.I)
    if m:
        pred = _resolve(project, m[3]) if m[3] else None
        succ = _resolve(project, m[4]) if m[4] else None
        nums = sorted(int(re.sub(r"\D", "", a.id) or 0) for a in project.activities)
        nid = f"A{(nums[-1] if nums else 1000) + 10}"
        wbs = project.activity(pred).wbs_id if pred else (project.activity(succ).wbs_id if succ else None)
        ops.append(PatchOp(op="add_activity", activity_id=nid, name=m[1], duration_days=_days(m[2]), wbs_code=wbs,
                           predecessor_id=pred, successor_id=succ, reason=t))
        if pred and succ:
            ops.append(PatchOp(op="remove_link", predecessor_id=pred, successor_id=succ, reason="inserted between"))
        return Patch(ops=ops, message=f"Inserted {nid} '{m[1]}' ({_days(m[2]):g}d)" + (f" between {pred} and {succ}" if pred and succ else "") + ".")

    m = re.match(r"(?:complete|finished?|done)\s+" + ID + r"(?:\s+(?:on|at)\s+(.+))?$", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        d = _date(m[2]) if m[2] else (project.data_date or project.start).strftime("%Y-%m-%d")
        ops.append(PatchOp(op="set_progress", activity_id=aid, actual_finish=d, reason=t))
        return Patch(ops=ops, message=f"{aid} complete on {d}.")

    m = re.match(r"(?:started?|begin|actual start)\s+" + ID + r"(?:\s+(?:on|at)\s+(.+))?$", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        d = _date(m[2]) if m[2] else (project.data_date or project.start).strftime("%Y-%m-%d")
        ops.append(PatchOp(op="set_progress", activity_id=aid, actual_start=d, percent_complete=0, reason=t))
        return Patch(ops=ops, message=f"{aid} started on {d}.")

    if re.match(r"(project\s+)?start(s|ing)?(\s+on)?\s+", low):
        d = _date(t)
        if not d:
            raise CommandError("Give a date, e.g. 'start 4 May 2026'.")
        ops.append(PatchOp(op="set_project_start", date=d, reason=t))
        return Patch(ops=ops, message=f"Project start moved to {d}.")

    if re.match(r"(must\s+)?(finish|complete|handover|deadline|end)\s*(by|on|before|date)?\s+", low) or low.startswith("deadline"):
        d = _date(t)
        if not d:
            raise CommandError("Give a date, e.g. 'finish by 1 Nov 2026'.")
        ops.append(PatchOp(op="set_must_finish_by", date=d, reason=t))
        return Patch(ops=ops, message=f"Must finish by {d}. Float is now measured against that date.")

    m = re.match(r"(?:data\s+date|status\s+date|progress\s+to|update\s+to)\s+(.+)$", t, re.I)
    if m:
        d = _date(m[1])
        if not d:
            raise CommandError("Give a date.")
        return Patch(ops=[PatchOp(op="note", reason=f"__data_date__{d}")], message=f"Data date set to {d}.")

    m = re.match(r"constrain\s+" + ID + r"\s+(start|finish)\s+(on or after|on or before|no earlier than|no later than|by|on|before|after)\s+(.+)$", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        d = _date(m[4])
        if not d:
            raise CommandError("Give a date.")
        which, how = m[2].lower(), m[3].lower()
        if how in ("on",):
            ctype = f"must_{which}_on"
        elif how in ("on or after", "no earlier than", "after"):
            ctype = f"{which}_on_or_after"
        else:
            ctype = f"{which}_on_or_before"
        ops.append(PatchOp(op="set_constraint", activity_id=aid, constraint_type=ctype, date=d, reason=t))  # type: ignore[arg-type]
        return Patch(ops=ops, message=f"{aid}: {ctype.replace('_', ' ')} {d}.")

    m = re.match(r"unconstrain\s+" + ID + r"\s*$", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        ops.append(PatchOp(op="clear_constraint", activity_id=aid, reason=t))
        return Patch(ops=ops, message=f"Constraint removed from {aid}.")

    m = re.match(r"(?:progress|update)\s+" + ID + r"\s+(\d+(?:\.\d+)?)\s*%(?:\s+(?:as\s+of|on|at)\s+(.+))?$", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        d = _date(m[3]) if m[3] else None
        ops.append(PatchOp(op="set_progress", activity_id=aid, percent_complete=float(m[2]), actual_start=None, reason=t))
        msg = f"{aid} marked {m[2]}% complete."
        if d:
            ops.insert(0, PatchOp(op="note", reason=f"__data_date__{d}"))
            msg += f" Data date {d}."
        return Patch(ops=ops, message=msg)

    m = re.match(r"assign\s+" + ID + r"\s+(?:to\s+)?(.+)$", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        ops.append(PatchOp(op="note", reason=f"__assign__{aid}__{m[2].strip()}"))
        return Patch(ops=ops, message=f"Assigned '{m[2].strip()}' to {aid}.")

    m = re.match(r"(?:move|put)\s+" + ID + r"\s+(?:to|into|under)\s+wbs\s+(\S+)", t, re.I)
    if m:
        aid = _resolve(project, m[1])
        ops.append(PatchOp(op="move_to_wbs", activity_id=aid, wbs_code=m[2], reason=t))
        return Patch(ops=ops, message=f"{aid} moved to WBS {m[2]}.")

    raise CommandError("I did not understand that. Type 'help' for the command list.")
