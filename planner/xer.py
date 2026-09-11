"""Primavera P6 XER import / export.

XER is a tab-delimited text dump of P6 tables. We read the tables we need
(PROJECT, CALENDAR, PROJWBS, TASK, TASKPRED, RSRC, TASKRSRC) into a Project and
write the same set back out, which P6 and Asta Powerproject both import.
"""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from typing import Iterable

from .model import (Activity, ActivityType, Assignment, Calendar, Constraint, LinkType, Project,
                    Relationship, Resource, Status, WBSNode)

DATE_FMT = "%Y-%m-%d %H:%M"
EXCEL_EPOCH = date(1899, 12, 30)

TASK_TYPE_IN = {
    "TT_Task": ActivityType.TASK, "TT_Rsrc": ActivityType.TASK, "TT_Mile": ActivityType.START_MILESTONE,
    "TT_FinMile": ActivityType.FINISH_MILESTONE, "TT_LOE": ActivityType.LOE, "TT_WBS": ActivityType.LOE,
}
TASK_TYPE_OUT = {
    ActivityType.TASK: "TT_Task", ActivityType.START_MILESTONE: "TT_Mile",
    ActivityType.FINISH_MILESTONE: "TT_FinMile", ActivityType.LOE: "TT_LOE",
}
STATUS_IN = {"TK_NotStart": Status.NOT_STARTED, "TK_Active": Status.IN_PROGRESS, "TK_Complete": Status.COMPLETE}
STATUS_OUT = {v: k for k, v in STATUS_IN.items()}
CSTR_IN = {
    "CS_MSOA": Constraint.START_ON_OR_AFTER, "CS_MSOB": Constraint.START_ON_OR_BEFORE,
    "CS_MEOA": Constraint.FINISH_ON_OR_AFTER, "CS_MEOB": Constraint.FINISH_ON_OR_BEFORE,
    "CS_MSO": Constraint.MUST_START_ON, "CS_MEO": Constraint.MUST_FINISH_ON, "CS_ALAP": Constraint.AS_LATE_AS_POSSIBLE,
}
CSTR_OUT = {v: k for k, v in CSTR_IN.items()}
LINK_IN = {"PR_FS": LinkType.FS, "PR_SS": LinkType.SS, "PR_FF": LinkType.FF, "PR_SF": LinkType.SF}
LINK_OUT = {v: k for k, v in LINK_IN.items()}
RSRC_IN = {"RT_Labor": "labour", "RT_Mat": "material", "RT_Equip": "equipment"}
RSRC_OUT = {v: k for k, v in RSRC_IN.items()}


# --------------------------------------------------------------------------------------
# low level
# --------------------------------------------------------------------------------------
def parse_tables(text: str) -> dict[str, list[dict[str, str]]]:
    tables: dict[str, list[dict[str, str]]] = {}
    name, fields = None, []
    for raw in text.splitlines():
        if not raw:
            continue
        parts = raw.rstrip("\r\n").split("\t")
        tag = parts[0]
        if tag == "%T":
            name, fields = parts[1], []
            tables.setdefault(name, [])
        elif tag == "%F":
            fields = parts[1:]
        elif tag == "%R" and name:
            row = parts[1:]
            tables[name].append({f: (row[i] if i < len(row) else "") for i, f in enumerate(fields)})
        elif tag in ("ERMHDR", "%E"):
            continue
    return tables


def _dt(s: str) -> datetime | None:
    s = (s or "").strip()
    if not s:
        return None
    for fmt in (DATE_FMT, "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None


def _f(s: str, default: float = 0.0) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def fmt_dt(d: datetime | None) -> str:
    return d.strftime(DATE_FMT) if d else ""


# --------------------------------------------------------------------------------------
# calendar data (the "(0||CalendarType()( ... ))" blob)
# --------------------------------------------------------------------------------------
class _Node:
    def __init__(self, name: str, attrs: str):
        self.name, self.attrs, self.children = name, attrs, []


_CAL_TOKEN = re.compile(r"0\|\|([^(]*)\(([^()]*)\)|\(|\)")


def _parse_nodes(s: str) -> list[_Node]:
    """Parse the clndr_data blob.

    P6 writes every node wrapped in its own parentheses: ``(0||2()((0||0(s|08:00|f|12:00)())))``.
    Some exporters (and our writer) drop the wrappers: ``0||2()( 0||0(s|08:00|f|12:00) )``.
    A bare "(" not directly after a node is treated as a transparent wrapper.
    """
    root = _Node("root", "")
    stack: list[_Node | None] = [root]
    tokens = list(_CAL_TOKEN.finditer(s))
    i = 0
    while i < len(tokens):
        tok = tokens[i].group(0)
        if tok == "(":
            stack.append(None)
            i += 1
            continue
        if tok == ")":
            if len(stack) > 1:
                stack.pop()
            i += 1
            continue
        node = _Node(tokens[i].group(1).strip(), tokens[i].group(2))
        parent = next(x for x in reversed(stack) if x is not None)
        parent.children.append(node)
        if i + 1 < len(tokens) and tokens[i + 1].group(0) == "(":
            stack.append(node)
            i += 2
        else:
            i += 1
    return root.children


def _shift_hours(children: list[_Node]) -> float:
    total = 0.0
    for sh in children:
        m = re.search(r"s\|(\d{1,2}):(\d{2})\|f\|(\d{1,2}):(\d{2})", sh.attrs)
        if m:
            a = int(m[1]) * 60 + int(m[2])
            b = int(m[3]) * 60 + int(m[4])
            if b <= a:
                b += 24 * 60
            total += (b - a) / 60
    return total


def parse_clndr_data(blob: str, cal: Calendar) -> Calendar:
    if not blob:
        return cal
    nodes = _parse_nodes(blob)
    flat: list[_Node] = []

    def walk(ns):
        for x in ns:
            flat.append(x)
            walk(x.children)

    walk(nodes)
    for node in flat:
        if node.name == "DaysOfWeek":
            wd, first_start, hours = [], None, []
            for day in node.children:
                if not day.name.isdigit():
                    continue
                h = _shift_hours(day.children)
                if h > 0:
                    wd.append((int(day.name) - 2) % 7)  # P6 1=Sun .. 7=Sat -> Mon=0
                    hours.append(h)
                    if first_start is None and day.children:
                        m = re.search(r"s\|(\d{1,2}):(\d{2})", day.children[0].attrs)
                        if m:
                            first_start = time(int(m[1]), int(m[2]))
            if wd:
                cal.working_days = sorted(wd)
                cal.hours_per_day = round(max(set(hours), key=hours.count), 2)
            if first_start:
                cal.day_start = first_start
        elif node.name == "Exceptions":
            for ex in node.children:
                m = re.search(r"d\|(\d+)", ex.attrs)
                if not m:
                    continue
                d = EXCEL_EPOCH + timedelta(days=int(m[1]))
                cal.exceptions[d] = _shift_hours(ex.children)
    return cal


def build_clndr_data(cal: Calendar) -> str:
    def shift(h: float) -> str:
        s = datetime.combine(date.today(), cal.day_start)
        e = s + timedelta(hours=h)
        return f"0||0(s|{s:%H:%M}|f|{e:%H:%M})"

    days = []
    for p6day in range(1, 8):
        wd = (p6day - 2) % 7
        inner = f"( {shift(cal.hours_per_day)} )" if wd in cal.working_days else "( )"
        days.append(f"0||{p6day}(){inner}")
    exc = []
    for i, (d, h) in enumerate(sorted(cal.exceptions.items())):
        serial = (d - EXCEL_EPOCH).days
        inner = f"( {shift(h)} )" if h > 0 else "( )"
        exc.append(f"0||{i}(d|{serial}){inner}")
    return ("(0||CalendarType()( 0||DaysOfWeek()( " + " ".join(days) +
            " ) 0||VIEW(ShowTotal|Y)() 0||Exceptions()( " + " ".join(exc) + " ) ))")


# --------------------------------------------------------------------------------------
# read
# --------------------------------------------------------------------------------------
def read_xer(text: str, project_index: int = 0) -> Project:
    t = parse_tables(text)
    projects = [r for r in t.get("PROJECT", []) if r.get("export_flag", "Y") != "N"] or t.get("PROJECT", [])
    if not projects:
        raise ValueError("XER has no PROJECT table")
    pr = projects[min(project_index, len(projects) - 1)]
    pid = pr["proj_id"]

    cals: dict[str, Calendar] = {}
    for r in t.get("CALENDAR", []):
        cal = Calendar(id=r["clndr_id"], name=r.get("clndr_name") or r["clndr_id"],
                       hours_per_day=_f(r.get("day_hr_cnt"), 8.0) or 8.0)
        parse_clndr_data(r.get("clndr_data", ""), cal)
        cals[cal.id] = cal

    wbs_rows = [r for r in t.get("PROJWBS", []) if r.get("proj_id") == pid]
    root_ids = {r["wbs_id"] for r in wbs_rows if r.get("proj_node_flag") == "Y"}
    root = next((r for r in wbs_rows if r["wbs_id"] in root_ids), None)
    name = (root or {}).get("wbs_name") or pr.get("proj_short_name") or pid
    wbs = [WBSNode(id=r["wbs_id"], name=r.get("wbs_name", ""), code=r.get("wbs_short_name"),
                   parent_id=None if r.get("parent_wbs_id") in root_ids else (r.get("parent_wbs_id") or None),
                   seq=int(_f(r.get("seq_num"), 0)))
           for r in wbs_rows if r["wbs_id"] not in root_ids]

    task_rows = [r for r in t.get("TASK", []) if r.get("proj_id") == pid]
    id_by_task: dict[str, str] = {}
    acts: list[Activity] = []
    for r in task_rows:
        code = r.get("task_code") or r["task_id"]
        id_by_task[r["task_id"]] = code
        status = STATUS_IN.get(r.get("status_code", ""), Status.NOT_STARTED)
        target, remain = _f(r.get("target_drtn_hr_cnt")), _f(r.get("remain_drtn_hr_cnt"))
        if status == Status.COMPLETE:
            pct = 100.0
        elif status == Status.NOT_STARTED:
            pct = 0.0
        elif r.get("complete_pct_type") == "CP_Phys":
            pct = _f(r.get("phys_complete_pct"))
        else:  # CP_Drtn is the P6 default: duration % complete
            pct = round(100.0 * (target - remain) / target, 2) if target > 0 else _f(r.get("phys_complete_pct"))
        act_start, act_end = _dt(r.get("act_start_date", "")), _dt(r.get("act_end_date", ""))
        if status != Status.NOT_STARTED and act_start is None:
            act_start = _dt(r.get("target_start_date", "")) or _dt(r.get("early_start_date", ""))
        if status == Status.COMPLETE and act_end is None:
            act_end = _dt(r.get("target_end_date", "")) or _dt(r.get("early_end_date", "")) or act_start
        a = Activity(
            id=code, name=r.get("task_name", ""),
            wbs_id=None if r.get("wbs_id") in root_ids else (r.get("wbs_id") or None),
            calendar_id=r.get("clndr_id") or None,
            type=TASK_TYPE_IN.get(r.get("task_type", ""), ActivityType.TASK),
            duration_hours=_f(r.get("target_drtn_hr_cnt")),
            constraint=CSTR_IN.get(r.get("cstr_type", ""), Constraint.NONE),
            constraint_date=_dt(r.get("cstr_date", "")),
            status=status,
            actual_start=act_start, actual_finish=act_end,
            remaining_hours=remain if status != Status.NOT_STARTED else None,
            percent_complete=pct,
            early_start=_dt(r.get("early_start_date", "")), early_finish=_dt(r.get("early_end_date", "")),
            late_start=_dt(r.get("late_start_date", "")), late_finish=_dt(r.get("late_end_date", "")),
            total_float_hours=_f(r.get("total_float_hr_cnt")) if r.get("total_float_hr_cnt") else None,
            free_float_hours=_f(r.get("free_float_hr_cnt")) if r.get("free_float_hr_cnt") else None,
            baseline_start=_dt(r.get("target_start_date", "")), baseline_finish=_dt(r.get("target_end_date", "")),
        )
        acts.append(a)

    rels = []
    for r in t.get("TASKPRED", []):
        if r.get("task_id") in id_by_task and r.get("pred_task_id") in id_by_task:
            rels.append(Relationship(predecessor_id=id_by_task[r["pred_task_id"]], successor_id=id_by_task[r["task_id"]],
                                     type=LINK_IN.get(r.get("pred_type", ""), LinkType.FS), lag_hours=_f(r.get("lag_hr_cnt"))))

    res = {r["rsrc_id"]: Resource(id=r.get("rsrc_short_name") or r["rsrc_id"], name=r.get("rsrc_name", ""),
                                  type=RSRC_IN.get(r.get("rsrc_type", ""), "labour"))
           for r in t.get("RSRC", [])}
    assigns, used = [], set()
    for r in t.get("TASKRSRC", []):
        if r.get("task_id") in id_by_task and r.get("rsrc_id") in res:
            used.add(r["rsrc_id"])
            assigns.append(Assignment(activity_id=id_by_task[r["task_id"]], resource_id=res[r["rsrc_id"]].id,
                                      units=_f(r.get("target_qty")), cost=_f(r.get("target_cost"))))

    default_cal = pr.get("clndr_id") or (next(iter(cals)) if cals else "std")
    proj = Project(
        id=pr.get("proj_short_name") or pid, name=name,
        start=_dt(pr.get("plan_start_date", "")) or datetime.now().replace(hour=8, minute=0, second=0, microsecond=0),
        data_date=_dt(pr.get("last_recalc_date", "")),
        must_finish_by=_dt(pr.get("plan_end_date", "")),
        default_calendar_id=default_cal, calendars=cals, wbs=wbs, activities=acts, relationships=rels,
        resources=[res[k] for k in res if k in used] or list(res.values()), assignments=assigns,
    )
    proj.ensure_default_calendar()
    return proj


def read_xer_file(path: str, project_index: int = 0) -> Project:
    raw = open(path, "rb").read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    return read_xer(text, project_index)


# --------------------------------------------------------------------------------------
# write
# --------------------------------------------------------------------------------------
def _table(name: str, fields: list[str], rows: Iterable[dict]) -> str:
    out = [f"%T\t{name}", "%F\t" + "\t".join(fields)]
    for r in rows:
        out.append("%R\t" + "\t".join(str(r.get(f, "")) for f in fields))
    return "\n".join(out)


def write_xer(project: Project, currency: str = "GBP") -> str:
    project.ensure_default_calendar()
    now = datetime.now()
    pid = 1
    cal_ids = {cid: i + 1 for i, cid in enumerate(project.calendars)}
    task_ids = {a.id: i + 1 for i, a in enumerate(project.activities)}
    wbs_ids = {w.id: i + 2 for i, w in enumerate(project.wbs)}  # 1 is the project root node
    rsrc_ids = {r.id: i + 1 for i, r in enumerate(project.resources)}

    header = "\t".join(["ERMHDR", "19.12", now.strftime("%Y-%m-%d"), "Project", "admin", "admin",
                        "dbxDatabaseNoName", "Project Management", currency])

    currtype = _table("CURRTYPE", ["curr_id", "decimal_digit_cnt", "curr_symbol", "decimal_symbol", "digit_group_symbol",
                                   "pos_curr_fmt_type", "neg_curr_fmt_type", "curr_type", "curr_short_name", "group_digit_cnt",
                                   "base_exch_rate"],
                      [{"curr_id": 1, "decimal_digit_cnt": 2, "curr_symbol": "£", "decimal_symbol": ".", "digit_group_symbol": ",",
                        "pos_curr_fmt_type": "#1,1.1", "neg_curr_fmt_type": "(#1,1.1)", "curr_type": "Pound Sterling",
                        "curr_short_name": currency, "group_digit_cnt": 3, "base_exch_rate": 1}])

    calendar = _table("CALENDAR", ["clndr_id", "default_flag", "clndr_name", "proj_id", "base_clndr_id", "last_chng_date",
                                   "clndr_type", "day_hr_cnt", "week_hr_cnt", "month_hr_cnt", "year_hr_cnt", "rsrc_private",
                                   "clndr_data"],
                      [{"clndr_id": cal_ids[c.id], "default_flag": "Y" if c.id == project.default_calendar_id else "N",
                        "clndr_name": c.name, "proj_id": "", "base_clndr_id": "", "last_chng_date": fmt_dt(now),
                        "clndr_type": "CA_Base", "day_hr_cnt": c.hours_per_day,
                        "week_hr_cnt": c.hours_per_day * len(c.working_days),
                        "month_hr_cnt": round(c.hours_per_day * len(c.working_days) * 52 / 12, 1),
                        "year_hr_cnt": c.hours_per_day * len(c.working_days) * 52, "rsrc_private": "N",
                        "clndr_data": build_clndr_data(c)} for c in project.calendars.values()])

    finish = project.finish or project.start
    proj_t = _table("PROJECT", ["proj_id", "fy_start_month_num", "rsrc_self_add_flag", "allow_complete_flag",
                                "allow_neg_act_flag", "def_complete_pct_type", "proj_short_name", "orig_proj_id",
                                "clndr_id", "sum_base_proj_id", "task_code_base", "task_code_step", "priority_num",
                                "wbs_max_sum_level", "strgy_priority_num", "last_checksum", "critical_drtn_hr_cnt",
                                "def_cost_per_qty", "last_recalc_date", "plan_start_date", "plan_end_date",
                                "scd_end_date", "add_date", "last_tasksum_date", "fcst_start_date", "def_duration_type",
                                "task_code_prefix", "guid", "def_qty_type", "add_by_name", "web_local_root_path",
                                "proj_url", "def_rate_type", "add_act_remain_flag", "act_this_per_link_flag",
                                "def_task_type", "act_pct_link_flag", "critical_path_type", "task_code_prefix_flag",
                                "def_rollup_dates_flag", "use_project_baseline_flag", "rem_target_link_flag",
                                "reset_planned_flag", "allow_neg_act_flag", "sum_assign_level", "last_fin_dates_id",
                                "fintmpl_id", "last_baseline_update_date", "cr_external_key", "apply_actuals_date",
                                "location_id", "loaded_scope_level", "export_flag", "new_fin_dates_id",
                                "baselines_to_export", "baseline_names_to_export", "next_data_date",
                                "close_period_flag", "sum_refresh_date", "trsrcsum_loaded"],
                    [{"proj_id": pid, "fy_start_month_num": 1, "rsrc_self_add_flag": "N", "allow_complete_flag": "N",
                      "allow_neg_act_flag": "N", "def_complete_pct_type": "CP_Drtn", "proj_short_name": project.id[:20],
                      "clndr_id": cal_ids[project.default_calendar_id], "task_code_base": 1000, "task_code_step": 10,
                      "priority_num": 10, "wbs_max_sum_level": 0, "strgy_priority_num": 500, "critical_drtn_hr_cnt": 0,
                      "def_cost_per_qty": 0, "last_recalc_date": fmt_dt(project.data_date or project.start),
                      "plan_start_date": fmt_dt(project.start), "plan_end_date": fmt_dt(project.must_finish_by),
                      "scd_end_date": fmt_dt(finish), "add_date": fmt_dt(now), "def_duration_type": "DT_FixedDrtn",
                      "task_code_prefix": "A", "guid": "", "def_qty_type": "QT_Hour", "add_by_name": "admin",
                      "def_rate_type": "COST_PER_QTY", "add_act_remain_flag": "N", "act_this_per_link_flag": "Y",
                      "def_task_type": "TT_Task", "act_pct_link_flag": "Y", "critical_path_type": "CT_TotFloat",
                      "task_code_prefix_flag": "Y", "def_rollup_dates_flag": "Y", "use_project_baseline_flag": "Y",
                      "rem_target_link_flag": "Y", "reset_planned_flag": "N", "sum_assign_level": "SL_Taskrsrc",
                      "export_flag": "Y", "loaded_scope_level": 7, "close_period_flag": "N", "trsrcsum_loaded": "N"}])

    wbs_rows = [{"wbs_id": 1, "proj_id": pid, "obs_id": "", "seq_num": 0, "proj_node_flag": "Y", "sum_data_flag": "Y",
                 "status_code": "WS_Open", "wbs_short_name": project.id[:20], "wbs_name": project.name,
                 "parent_wbs_id": "", "ev_user_pct": 6, "ev_etc_user_value": 0.88, "orig_cost": 0, "indep_remain_total_cost": 0,
                 "ann_dscnt_rate_pct": 0, "dscnt_period_type": "", "indep_remain_work_qty": 0, "anticip_start_date": "",
                 "anticip_end_date": "", "ev_compute_type": "EC_Cmp_pct", "ev_etc_compute_type": "EE_Rem_hrs"}]
    for w in project.wbs:
        wbs_rows.append({**wbs_rows[0], "wbs_id": wbs_ids[w.id], "seq_num": w.seq, "proj_node_flag": "N",
                         "wbs_short_name": (w.code or w.id)[:20], "wbs_name": w.name,
                         "parent_wbs_id": wbs_ids.get(w.parent_id, 1) if w.parent_id else 1})
    projwbs = _table("PROJWBS", list(wbs_rows[0].keys()), wbs_rows)

    rsrc = _table("RSRC", ["rsrc_id", "parent_rsrc_id", "clndr_id", "role_id", "shift_id", "user_id", "pobs_id", "guid",
                           "rsrc_seq_num", "email_addr", "employee_code", "office_phone", "other_phone", "rsrc_name",
                           "rsrc_short_name", "rsrc_title_name", "def_qty_per_hr", "cost_qty_type", "ot_factor",
                           "active_flag", "auto_compute_act_flag", "def_cost_qty_link_flag", "ot_flag", "curr_id",
                           "unit_id", "rsrc_type", "location_id", "rsrc_notes", "load_tasks_flag", "level_flag",
                           "last_checksum"],
                  [{"rsrc_id": rsrc_ids[r.id], "clndr_id": cal_ids[project.default_calendar_id], "rsrc_seq_num": i + 1,
                    "rsrc_name": r.name, "rsrc_short_name": r.id[:20], "def_qty_per_hr": 1, "cost_qty_type": "QT_Hour",
                    "ot_factor": 1, "active_flag": "Y", "auto_compute_act_flag": "Y", "def_cost_qty_link_flag": "Y",
                    "ot_flag": "N", "curr_id": 1, "rsrc_type": RSRC_OUT.get(r.type, "RT_Labor"), "load_tasks_flag": "N",
                    "level_flag": "N"} for i, r in enumerate(project.resources)])

    task_fields = ["task_id", "proj_id", "wbs_id", "clndr_id", "phys_complete_pct", "rev_fdbk_flag", "est_wt", "lock_plan_flag",
                   "auto_compute_act_flag", "complete_pct_type", "task_type", "duration_type", "status_code", "task_code",
                   "task_name", "rsrc_id", "total_float_hr_cnt", "free_float_hr_cnt", "remain_drtn_hr_cnt", "act_work_qty",
                   "remain_work_qty", "target_work_qty", "target_drtn_hr_cnt", "target_equip_qty", "act_equip_qty",
                   "remain_equip_qty", "cstr_date", "act_start_date", "act_end_date", "late_start_date", "late_end_date",
                   "expect_end_date", "early_start_date", "early_end_date", "restart_date", "reend_date", "target_start_date",
                   "target_end_date", "rem_late_start_date", "rem_late_end_date", "cstr_type", "priority_type", "suspend_date",
                   "resume_date", "float_path", "float_path_order", "guid", "tmpl_guid", "cstr_date2", "cstr_type2",
                   "driving_path_flag", "act_this_per_work_qty", "act_this_per_equip_qty", "external_early_start_date",
                   "external_late_end_date", "create_date", "update_date", "create_user", "update_user", "location_id",
                   "crt_path_num"]
    task_rows = []
    for a in project.activities:
        rem = a.remaining_hours if a.remaining_hours is not None else (0.0 if a.status == Status.COMPLETE else a.duration_hours)
        task_rows.append({
            "task_id": task_ids[a.id], "proj_id": pid, "wbs_id": wbs_ids.get(a.wbs_id, 1) if a.wbs_id else 1,
            "clndr_id": cal_ids.get(a.calendar_id or project.default_calendar_id, cal_ids[project.default_calendar_id]),
            "phys_complete_pct": a.percent_complete, "rev_fdbk_flag": "N", "est_wt": 1, "lock_plan_flag": "N",
            "auto_compute_act_flag": "Y", "complete_pct_type": "CP_Drtn", "task_type": TASK_TYPE_OUT[a.type],
            "duration_type": "DT_FixedDrtn", "status_code": STATUS_OUT[a.status], "task_code": a.id[:20], "task_name": a.name[:120],
            "total_float_hr_cnt": "" if a.total_float_hours is None else a.total_float_hours,
            "free_float_hr_cnt": "" if a.free_float_hours is None else a.free_float_hours,
            "remain_drtn_hr_cnt": rem, "act_work_qty": 0, "remain_work_qty": 0, "target_work_qty": 0,
            "target_drtn_hr_cnt": a.duration_hours, "target_equip_qty": 0, "act_equip_qty": 0, "remain_equip_qty": 0,
            "cstr_date": fmt_dt(a.constraint_date) if a.constraint != Constraint.NONE else "",
            "act_start_date": fmt_dt(a.actual_start), "act_end_date": fmt_dt(a.actual_finish),
            "late_start_date": fmt_dt(a.late_start), "late_end_date": fmt_dt(a.late_finish),
            "early_start_date": fmt_dt(a.early_start), "early_end_date": fmt_dt(a.early_finish),
            "restart_date": fmt_dt(a.early_start), "reend_date": fmt_dt(a.early_finish),
            "target_start_date": fmt_dt(a.baseline_start or a.start), "target_end_date": fmt_dt(a.baseline_finish or a.finish),
            "rem_late_start_date": fmt_dt(a.late_start), "rem_late_end_date": fmt_dt(a.late_finish),
            "cstr_type": CSTR_OUT.get(a.constraint, ""), "priority_type": "PT_Normal", "driving_path_flag": "Y" if a.critical else "N",
            "act_this_per_work_qty": 0, "act_this_per_equip_qty": 0, "create_date": fmt_dt(now), "update_date": fmt_dt(now),
            "create_user": "admin", "update_user": "admin",
        })
    task = _table("TASK", task_fields, task_rows)

    taskpred = _table("TASKPRED", ["task_pred_id", "task_id", "pred_task_id", "proj_id", "pred_proj_id", "pred_type",
                                   "lag_hr_cnt", "comments", "float_path", "aref", "arls"],
                      [{"task_pred_id": i + 1, "task_id": task_ids[r.successor_id], "pred_task_id": task_ids[r.predecessor_id],
                        "proj_id": pid, "pred_proj_id": pid, "pred_type": LINK_OUT[r.type], "lag_hr_cnt": r.lag_hours}
                       for i, r in enumerate(project.relationships)
                       if r.successor_id in task_ids and r.predecessor_id in task_ids])

    taskrsrc = _table("TASKRSRC", ["taskrsrc_id", "task_id", "proj_id", "cost_qty_link_flag", "role_id", "acct_id", "rsrc_id",
                                   "pobs_id", "skill_level", "remain_qty", "target_qty", "remain_qty_per_hr", "target_lag_drtn_hr_cnt",
                                   "target_qty_per_hr", "act_ot_qty", "act_reg_qty", "relag_drtn_hr_cnt", "ot_factor",
                                   "cost_per_qty", "target_cost", "act_reg_cost", "act_ot_cost", "remain_cost", "act_start_date",
                                   "act_end_date", "restart_date", "reend_date", "target_start_date", "target_end_date",
                                   "rem_late_start_date", "rem_late_end_date", "rollup_dates_flag", "target_crv", "remain_crv",
                                   "actual_crv", "ts_pend_act_end_flag", "guid", "rate_type", "act_this_per_cost",
                                   "act_this_per_qty", "curv_id", "rsrc_type", "cost_per_qty_source_type", "create_user",
                                   "create_date", "has_rsrchours", "taskrsrc_sum_id"],
                      [{"taskrsrc_id": i + 1, "task_id": task_ids[x.activity_id], "proj_id": pid, "cost_qty_link_flag": "Y",
                        "rsrc_id": rsrc_ids[x.resource_id], "skill_level": 3, "remain_qty": x.units, "target_qty": x.units,
                        "remain_qty_per_hr": 0, "target_lag_drtn_hr_cnt": 0, "target_qty_per_hr": 0, "act_ot_qty": 0,
                        "act_reg_qty": 0, "relag_drtn_hr_cnt": 0, "ot_factor": 0, "cost_per_qty": 0, "target_cost": x.cost,
                        "act_reg_cost": 0, "act_ot_cost": 0, "remain_cost": x.cost, "rollup_dates_flag": "Y",
                        "rate_type": "COST_PER_QTY", "act_this_per_cost": 0, "act_this_per_qty": 0,
                        "rsrc_type": RSRC_OUT.get(next((r.type for r in project.resources if r.id == x.resource_id), "labour"), "RT_Labor"),
                        "cost_per_qty_source_type": "ST_Rsrc", "create_user": "admin", "create_date": fmt_dt(now),
                        "has_rsrchours": "N"}
                       for i, x in enumerate(project.assignments)
                       if x.activity_id in task_ids and x.resource_id in rsrc_ids])

    return "\n".join([header, currtype, calendar, proj_t, projwbs, rsrc, task, taskpred, taskrsrc, "%E", ""])


def write_xer_file(project: Project, path: str) -> None:
    with open(path, "w", encoding="cp1252", errors="replace", newline="") as f:
        f.write(write_xer(project))
