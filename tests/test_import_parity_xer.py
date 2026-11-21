"""Golden-master parity for Primavera P6 XER import: web/import_xer.js must read every file
exactly as planner/xer.py does.

Each case is a file's raw bytes. Python decodes and reads them with planner.io.read_any (UTF-8,
falling back to cp1252) and then schedules the project; node decodes them with
PlannerEngine.decodeXerBytes, reads them with PlannerEngine.readXer and schedules with
PlannerEngine.schedule. The decoded text (by hash), the project as read, the scheduled project
and any error text are compared, under every timezone tests/test_parity.py uses.

Cases: the real P6 files in tests/fixtures, XER written by Python's write_xer for generated and
corpus projects (scheduled, baselined, progressed), non-ASCII names as cp1252 and UTF-8 bytes,
hand-written files that reach every branch of the reader, and malformed input.

Skipped when node is not installed.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import random
import subprocess
from pathlib import Path

import pytest

from planner.commands import parse_command
from planner.cpm import schedule
from planner.io import read_any
from planner.levelling import set_baseline
from planner.model import Project
from planner.plan import apply_patch
from planner.xer import read_xer, write_xer
from tests.test_parity import (BRIEFS, NODE, ROOT, TIMEZONES, _generated, constraints, diff, dst_year, hammocks,
                               links_and_lags, logic_loop, norm, progress)

RUNNER = Path(__file__).parent / "parity" / "xer_runner.js"
FIXTURES = ROOT / "tests" / "fixtures"

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


# ----------------------------------------------------------------------------------------
# corpus
# ----------------------------------------------------------------------------------------
def _xer(project: dict, *, scheduled=True, baseline=False, commands=(), encoding="utf-8", version=None) -> bytes:
    p = Project.model_validate(copy.deepcopy(project))
    if scheduled:
        schedule(p)
    if baseline:
        set_baseline(p, "Tender")
    for cmd in commands:
        apply_patch(p, parse_command(p, cmd))
    if commands:
        schedule(p)
    return write_xer(p, version=version).encode(encoding, errors="replace")


def _non_ascii() -> dict:
    proj = _generated(BRIEFS[0])
    proj["id"], proj["name"] = "CAFÉ-2", "Café façade – Phase 2"
    proj["activities"][1]["name"] = "Façade: pierre de Caen – £1,200/m² «premium»"
    proj["activities"][2]["name"] = "Ünterbau “quoted” ‘single’ … ½ ¾ ±"
    proj["activities"][3]["codes"] = {"Trade": "Maçon", "Zône": "Été"}
    proj["code_types"]["Zône"] = {"Été": "#a1b2c3"}
    proj["wbs"][0]["name"] = "Öffentliche Straße"
    proj["resources"][0]["name"] = "Grúa torre €"
    return proj


CAL_WRAPPED = ("(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|07:30|f|12:00)())(0||1(s|13:00|f|16:30)())))"
               "(0||3()((0||0(s|07:30|f|16:00)())))(0||4()((0||0(s|07:30|f|16:00)())))(0||5()((0||0(s|07:30|f|16:00)())))"
               "(0||6()((0||0(s|07:30|f|12:30)())))(0||7()())))(0||VIEW(ShowTotal|Y)())(0||Exceptions()((0||0(d|46113)())"
               "(0||1(d|46118)((0||0(s|08:00|f|12:00)())))(0||2(d|46125)())(0||3(d|46113)((0||0(s|09:00|f|13:00)())))))))")
# Mon/Tue 10h, Wed/Thu 8h, Fri/Sat 6h: a three-way tie, broken by CPython's set order (8.0 wins)
CAL_TIE_INT = ("0||CalendarType()( 0||DaysOfWeek()( 0||1()( ) 0||2()( 0||0(s|06:00|f|16:00) ) 0||3()( 0||0(s|06:00|f|16:00) ) "
               "0||4()( 0||0(s|08:00|f|16:00) ) 0||5()( 0||0(s|08:00|f|16:00) ) 0||6()( 0||0(s|08:00|f|14:00) ) "
               "0||7()( 0||0(s|08:00|f|14:00) ) ) 0||Exceptions()( 0||0(d|46120)( 0||0(s|08:00|f|10:30) ) ) )")
# five distinct non-integer lengths (forces a set resize) with a tie between 7.5 and 9.25
CAL_TIE_FRAC = ("(0||CalendarType()(0||DaysOfWeek()((0||1()((0||0(s|07:15|f|14:45)())))(0||2()((0||0(s|07:00|f|16:15)())))"
                "(0||3()((0||0(s|07:00|f|14:30)())))(0||4()((0||0(s|07:00|f|16:15)())))(0||5()((0||0(s|07:00|f|11:45)())))"
                "(0||6()((0||0(s|07:00|f|13:30)())))(0||7()((0||0(s|07:00|f|10:15)()))))))")
CAL_NIGHT = "(0||CalendarType()((0||DaysOfWeek()((0||2()((0||0(s|22:00|f|06:00)())))(0||3()((0||0(s|22:00|f|06:00)())))(0||x()((0||0(s|01:00|f|02:00)()))))))"


def _crafted() -> str:
    """Hand-written XER reaching every branch of read_xer. CRLF line endings, stray lines,
    calendars inserted out of numeric order (the first one is the default)."""
    rows = [
        "ERMHDR\t8.2\t2026-03-01\tProject\tadmin",
        "%R\tstray row before any table",
        "%T\tCURRTYPE", "%F\tcurr_id\tcurr_symbol", "%R\t1\t£",
        "%T\t", "%F\ta", "%R\tignored: empty table name",
        "%T\tCALENDAR",
        "%F\tclndr_id\tdefault_flag\tclndr_name\tproj_id\tday_hr_cnt\tclndr_data",
        f"%R\t30\tN\tFive day wrapped\t\t8\t{CAL_WRAPPED}",
        f"%R\t10\tY\tTie integer\t\t0\t{CAL_TIE_INT}",
        f"%R\t20\tN\t\t\tabc\t{CAL_TIE_FRAC}",
        f"%R\tnight\tN\tNights\t\t-0\t{CAL_NIGHT}",
        "%R\tplain\tN\tPlain 7.5\t\t7.5\t",
        "%R\tshort",
        "%T\tPROJECT",
        "%F\tproj_id\tproj_short_name\tclndr_id\tlast_recalc_date\tplan_start_date\tplan_end_date\texport_flag",
        "%R\t1\tOTHER\t10\t2026-01-05 08:00\t2026-01-05 08:00\t\tN",
        "%R\t2\tCRAFT\t\t2026-03-16 08:00\t2026-03-02 08:00\t2026-12-18 16:00\tY",
        "%T\tPROJWBS",
        "%F\twbs_id\tproj_id\tproj_node_flag\tseq_num\twbs_short_name\twbs_name\tparent_wbs_id",
        "%R\t100\t2\tY\t0\tCRAFT\tCrafted root\t",
        "%R\t101\t2\tN\t3.7\tW1\tZone 1\t100",
        "%R\t102\t2\tN\t-2.5\tW2\tZone 2\t100",
        "%R\t103\t2\tN\t\tW11\tZone 1 level 2\t101",
        "%R\t104\t2\tN\t1_0\t\t\t",
        "%R\t900\t1\tY\t0\tOTHER\tOther root\t",
        "%R\t901\t1\tN\t1\tOW\tOther zone\t900",
        "%T\tTASK",
        "%F\ttask_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_name\ttask_type\tstatus_code\tcomplete_pct_type\t"
        "phys_complete_pct\ttarget_drtn_hr_cnt\tremain_drtn_hr_cnt\tcstr_type\tcstr_date\tact_start_date\tact_end_date\t"
        "early_start_date\tearly_end_date\tlate_start_date\tlate_end_date\ttarget_start_date\ttarget_end_date\t"
        "total_float_hr_cnt\tfree_float_hr_cnt",
        "%R\t1\t2\t100\t30\tA100\tStart\tTT_Mile\tTK_Complete\tCP_Drtn\t0\t0\t0\t\t\t2026-03-02 08:00\t2026-03-02 08:00\t\t\t\t\t\t\t0\t0",
        "%R\t2\t2\t101\t30\tA110\tComplete, no actuals\tTT_Task\tTK_Complete\tCP_Drtn\t0\t40\t0\t\t\t\t\t2026-03-02 08:00\t2026-03-06 16:00\t\t\t2026-03-02 08:00\t\t\t",
        "%R\t3\t2\t101\t10\tA120\tDuration pct\tTT_Task\tTK_Active\tCP_Drtn\t10\t80\t30\t\t\t\t\t2026-03-09 08:00:30\t\t\t\t 2026-3-9  8:5 \t2026-03-20 16:00\t12.5\t",
        "%R\t4\t2\t102\t20\tA130\tPhysical pct\tTT_Rsrc\tTK_Active\tCP_Phys\t37.5\t60\t40\tCS_MSOA\t2026-04-01\t2026-03-10 08:00\t\t\t\t\t\t\t\tabc\t-4",
        "%R\t5\t2\t102\t30\tA140\tZero target\tTT_Task\tTK_Active\tCP_Units\t1_5.5\t0\t0\t\t\t2026-03-11 22:00\t\t\t\t\t\t\t\t\t",
        "%R\t6\t2\t103\t999\tA150\tUnknown calendar\tTT_Task\tTK_NotStart\tCP_Drtn\t50\t24\t24\tCS_MEOB\t2026-05-29 16:00\t2026-03-01 08:00\t\t\t\t\t\t\t\t\t",
        "%R\t7\t2\t900\tplain\tA160\tOther project's root\tTT_Task\t\t\t\t 16 \t\tCS_ALAP\t\t\t\t\t\t\t\t\t\t\t",
        "%R\t8\t2\t901\t\t\tNo code\tTT_LOE\tTK_NotStart\t\t\t0\t\tCS_BOGUS\t2026-02-30 08:00\t\t\t\t\t\t\t\t\t\t",
        "%R\t9\t2\t104\t30\tA180\tWBS summary\tTT_WBS\tTK_NotStart\t\t\t0\t\t\t2026-03-09T08:00\t\t\t\t\t\t\t\t\t\t",
        "%R\t10\t2\t101\t30\tA190\tMust start\tTT_Task\tTK_NotStart\t\t\t16\t16\tCS_MSO\t2026-04-20 08:00\t\t\t\t\t\t\t\t\t\t",
        "%R\t11\t2\t101\t30\tA200\tMust finish\tTT_Task\tTK_NotStart\t\t\t16\t16\tCS_MEO\t2026-05-15 16:00\t\t\t\t\t\t\t\t\t\t",
        "%R\t12\t2\t101\t30\tA210\tFinish on or after\tTT_Task\tTK_NotStart\t\t\t8\t8\tCS_MEOA\t2026-04-30 16:00:00\t\t\t\t\t\t\t\t\t\t",
        "%R\t13\t2\t101\t30\tA220\tStart on or before\tTT_Task\tTK_NotStart\t\t\t8\t8\tCS_MSOB\t2026-04-06 08:00\t\t\t\t\t\t\t\t\t\t",
        "%R\t14\t2\t\t30\tA999\tFinish\tTT_FinMile\tTK_NotStart\t\t\t0\t0\t\t\t\t\t\t\t\t\t\t\t\t",
        "%R\t15\t1\t901\t10\tB100\tOther project task\tTT_Task\tTK_NotStart\t\t\t8\t8\t\t\t\t\t\t\t\t\t\t\t\t",
        "%R\t16\t2\t101\t30\tA230\tShort row\tTT_Task",
        "%T\tTASKPRED",
        "%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt",
        "%R\t1\t2\t1\tPR_FS\t0", "%R\t2\t3\t2\tPR_SS\t8", "%R\t3\t4\t2\tPR_FF\t-4.5", "%R\t4\t5\t3\tPR_SF\t",
        "%R\t5\t6\t4\tPR_XX\t1e1", "%R\t6\t14\t6\tPR_FS\t0", "%R\t7\t14\t5\tPR_FS\t0", "%R\t8\t15\t1\tPR_FS\t0",
        "%R\t9\t8\t3\tPR_SS\t0", "%R\t10\t8\t4\tPR_FF\t0", "%R\t11\t10\t2\tPR_FS\t0", "%R\t12\t11\t10\tPR_FS\t0",
        "%R\t13\t12\t11\tPR_FS\t0", "%R\t14\t13\t1\tPR_FS\t0", "%R\t15\t14\t12\tPR_FS\t0", "%R\t16\t14\t13\tPR_FS\t0",
        "%R\t17\t7\t2\tPR_FS\t0", "%R\t18\t14\t7\tPR_FS\t0", "%R\t19\t9\t1\tPR_SS\t0", "%R\t20\t16\t1\tPR_FS\t0",
        "%R\t21\t14\t16\tPR_FS\t0", "%R\t22\t99\t1\tPR_FS\t0",
        "%T\tRSRC",
        "%F\trsrc_id\trsrc_short_name\trsrc_name\trsrc_type",
        "%R\t1\tLAB\tLabourers\tRT_Labor", "%R\t2\t\tExcavator\tRT_Equip", "%R\t3\tCONC\tConcrete\tRT_Mat",
        "%R\t1\tLAB2\tLabourers (renamed)\tRT_Other", "%R\t4\tUNUSED\tUnused\tRT_Labor",
        "%T\tTASKRSRC",
        "%F\ttaskrsrc_id\ttask_id\trsrc_id\ttarget_qty\ttarget_cost",
        "%R\t1\t2\t1\t80\t2400.50", "%R\t2\t3\t2\t\tx", "%R\t3\t4\t3\t12.25\t1e3", "%R\t4\t15\t1\t8\t0", "%R\t5\t3\t99\t8\t0",
        "%T\tACTVTYPE",
        "%F\tactv_code_type_id\tactv_code_type",
        "%R\t1\tTrade", "%R\t2\tconstructor", "%R\t3\t", "%R\t4\t__proto__",
        "%T\tACTVCODE",
        "%F\tactv_code_id\tactv_code_type_id\tactv_code_name\tshort_name\tcolor",
        "%R\t11\t1\tGroundworks\tGW\t255", "%R\t12\t1\t\tSN\t-1", "%R\t13\t2\tvalueOf\tVO\tabc", "%R\t14\t3\tEmpty type\tET\t16711680",
        "%R\t15\t99\tMissing type\tMT\t 42 ", "%R\t16\t\tNo type\tNT\t1_0", "%R\t17\t1\t\t\t0", "%R\t18\t4\ttoString\tTS\t+65280",
        "%R\t19\t1\tCarpenters\tCP\t99999999999",
        "%T\tTASKACTV",
        "%F\ttask_id\tactv_code_type_id\tactv_code_id\tproj_id",
        "%R\t2\t1\t11\t2", "%R\t3\t1\t12\t2", "%R\t3\t2\t13\t2", "%R\t4\t3\t14\t2", "%R\t5\t99\t15\t2", "%R\t6\t\t16\t2",
        "%R\t7\t1\t17\t2", "%R\t8\t4\t18\t2", "%R\t2\t1\t19\t2", "%R\t15\t1\t11\t1", "%R\t4\t1\t77\t2",
        "%E",
    ]
    return "\r\n".join(rows) + "\r\n"


def _random_calendars(n=400, seed=13) -> str:
    """Many random clndr_data blobs, P6-wrapped and bare, with repeated shift lengths so the
    hours_per_day mode often ties (Python breaks ties in set iteration order)."""
    rng = random.Random(seed)
    lengths = [4, 5.5, 6, 7.25, 7.5, 8, 8.5, 9.25, 10, 10.75, 12, 3 + 1 / 3]
    rows = []
    for i in range(n):
        wrap = rng.random() < 0.5
        node = (lambda name, attrs, kids: f"(0||{name}({attrs})({kids}))") if wrap else \
               (lambda name, attrs, kids: f"0||{name}({attrs})( {kids} )")

        def shifts():
            out, t = [], rng.choice([0, 5 * 60, 6 * 60, 7 * 60 + 30, 8 * 60, 13 * 60 + 15, 20 * 60])
            for j in range(rng.choice([1, 1, 1, 2])):
                mins = int(round(rng.choice(lengths) * 60 / (j + 1)))
                a, b = t % 1440, (t + mins) % 1440
                out.append(node(str(j), f"s|{a // 60:02d}:{a % 60:02d}|f|{b // 60}:{b % 60:02d}", ""))
                t += mins + 30
            return "".join(out) if wrap else " ".join(out)

        days = []
        for d in range(1, 8):
            name = rng.choice([str(d), str(d), str(d), f" {d} ", "x", str(d + 7)])
            days.append(node(name, "", shifts() if rng.random() < 0.75 else ""))
        exc = [node(str(k), f"d|{rng.randint(45000, 47500)}", shifts() if rng.random() < 0.3 else "") for k in range(rng.randint(0, 6))]
        sep = "" if wrap else " "
        blob = node("CalendarData", "", sep.join([node("DaysOfWeek", "", sep.join(days)), node("VIEW", "ShowTotal|Y", ""),
                                                  node("Exceptions", "", sep.join(exc))]))
        hpd = rng.choice(["8", "7.5", "", "0", "x", "10"])
        rows.append(f"%R\tc{i}\tRandom {i}\t{hpd}\t{blob}")
    return "\n".join(["%T\tCALENDAR", "%F\tclndr_id\tclndr_name\tday_hr_cnt\tclndr_data", *rows])


def _minimal(project_rows=("%R\t7\tMINI\t77\t2026-03-02 08:00\t2026-03-02 08:00\t",), extra=()) -> str:
    rows = ["ERMHDR\t8.2", "%T\tPROJECT",
            "%F\tproj_id\tproj_short_name\tclndr_id\tlast_recalc_date\tplan_start_date\texport_flag", *project_rows,
            "%T\tTASK", "%F\ttask_id\tproj_id\ttask_code\ttask_name\ttarget_drtn_hr_cnt",
            "%R\t1\t7\tM10\tOnly task\t40", "%R\t2\t8\tN10\tSecond project task\t16", *extra, "%E"]
    return "\n".join(rows)


def _malformed() -> list[tuple[str, bytes]]:
    head = "ERMHDR\t8.2\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\tplan_start_date\n%R\t1\tBAD\t2026-03-02 08:00\n"
    cal = "%T\tCALENDAR\n%F\tclndr_id\tclndr_name\tclndr_data\n"
    rng = random.Random(5)
    return [
        ("empty", b""),
        ("no-project-table", b"ERMHDR\t8.2\n%T\tTASK\n%F\ttask_id\ttask_code\n%R\t1\tA\n%E\n"),
        ("project-table-without-rows", b"ERMHDR\t8.2\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\n%E\n"),
        ("table-without-name", b"ERMHDR\t8.2\n%T\n%F\tproj_id\n%R\t1\n"),
        ("project-without-proj_id", b"%T\tPROJECT\n%F\tproj_short_name\n%R\tX\n"),
        ("task-without-task_id", (head + "%T\tTASK\n%F\tproj_id\ttask_code\n%R\t1\t\n").encode()),
        ("calendar-without-clndr_id", (head + "%T\tCALENDAR\n%F\tclndr_name\n%R\tStd\n").encode()),
        ("wbs-without-wbs_id", (head + "%T\tPROJWBS\n%F\tproj_id\tproj_node_flag\n%R\t1\tN\n").encode()),
        ("rsrc-without-rsrc_id", (head + "%T\tRSRC\n%F\trsrc_name\n%R\tX\n").encode()),
        ("actvcode-without-id", (head + "%T\tACTVCODE\n%F\tactv_code_name\n%R\tX\n").encode()),
        ("calendar-hour-25", (head + cal + "%R\t1\tBad\t(0||DaysOfWeek()((0||2()((0||0(s|25:00|f|26:00)())))))\n").encode()),
        ("calendar-minute-75", (head + cal + "%R\t1\tBad\t(0||DaysOfWeek()((0||2()((0||0(s|7:75|f|16:00)())))))\n").encode()),
        ("exception-out-of-range", (head + cal + "%R\t1\tBad\t(0||Exceptions()((0||0(d|99999999)())))\n").encode()),
        ("exception-timedelta-overflow", (head + cal + "%R\t1\tBad\t(0||Exceptions()((0||0(d|1000000000)())))\n").encode()),
        ("wbs-seq-nan", (head + "%T\tPROJWBS\n%F\twbs_id\tproj_id\tseq_num\n%R\t5\t1\tnan\n").encode()),
        ("wbs-seq-inf", (head + "%T\tPROJWBS\n%F\twbs_id\tproj_id\tseq_num\n%R\t5\t1\t-Infinity\n").encode()),
        ("binary-garbage", bytes(rng.randrange(256) for _ in range(3000))),
        ("plain-text", "hello\tworld\n%R\t1\n".encode()),
        ("logic-loop", _minimal(extra=("%T\tTASKPRED", "%F\ttask_id\tpred_task_id", "%R\t1\t1")).encode()),
    ]


def build_cases() -> list[tuple[str, dict]]:
    raw: list[tuple[str, bytes, int | None]] = []
    for f in sorted(FIXTURES.glob("*.xer")):
        raw.append((f"fixture-{f.stem}", f.read_bytes(), None))
    for i in (0, 2, 4, 6, 8):
        raw.append((f"written-generated-{i}", _xer(_generated(BRIEFS[i])), None))
    raw.append(("written-generated-0-unscheduled", _xer(_generated(BRIEFS[0]), scheduled=False), None))
    raw.append(("written-generated-1-cp1252", _xer(_generated(BRIEFS[1]), encoding="cp1252"), None))
    raw.append(("written-generated-0-progressed", _xer(_generated(BRIEFS[0]), baseline=True, commands=(
        "complete A1010 on 6 Mar 2026", "started A1020 on 9 Mar 2026", "progress A1030 37.5% as of 20 Apr 2026",
        "constrain A1100 finish on 30 Jun 2026", "data date 2026-04-20")), None))
    raw.append(("written-generated-3-progressed", _xer(_generated(BRIEFS[3]), baseline=True, commands=(
        "progress A1010 100%", "add 2 weeks to A1040", "link A1020 -> A1040 FF+1.5d", "data date 2026-08-03")), None))
    for fn in (progress, constraints, hammocks, links_and_lags, dst_year):
        raw.append((f"written-{fn.__name__}", _xer(fn()), None))
    raw.append(("written-progress-baselined", _xer(progress(), baseline=True), None))
    for v in ("15.2", "19", "21", "24", "8.4", "99.9"):              # target P6 version: only the ERMHDR line changes
        raw.append((f"written-version-{v}", _xer(progress(), version=v), None))
    uf = copy.deepcopy(progress())
    uf["user_fields"] = [{"name": "Package", "type": "text"}, {"name": "Cost", "type": "number"}, {"name": "Permit due", "type": "date"}]
    for i, a in enumerate(uf["activities"]):
        a["fields"] = {"Package": f"Pkg {i % 3}", "Cost": 1250.5 * i, "Permit due": f"2026-04-{i % 28 + 1:02d}"} if i % 2 == 0 else {"Undeclared": "x"}
    raw.append(("written-user-fields", _xer(uf), None))
    udf = ("%T\tUDFTYPE", "%F\tudf_type_id\ttable_name\tudf_type_name\tudf_type_label\tlogical_data_type",
           "%R\t1\tTASK\tuser_field_1\tSupplier\tFT_TEXT", "%R\t2\tTASK\tuser_field_2\t\tFT_INT",
           "%R\t3\tTASK\tuser_field_3\tValue\tFT_MONEY", "%R\t4\tTASK\tuser_field_4\tDue\tFT_END_DATE",
           "%R\t5\tPROJWBS\tuser_field_5\tWBS only\tFT_TEXT", "%R\t6\tTASK\tuser_field_6\tSupplier\tFT_INT",
           "%R\t7\tTASK\t\t\tFT_TEXT", "%R\t8\tTASK\tuser_field_8\tFlag\tFT_STATICTYPE", "%R\t9\tTASK\tuser_field_9\tOdd\tFT_UNKNOWN",
           "%T\tUDFVALUE", "%F\tudf_type_id\tfk_id\tproj_id\tudf_date\tudf_number\tudf_text",
           "%R\t1\t1\t7\t\t\tAcme", "%R\t2\t1\t7\t\t42\t", "%R\t3\t1\t7\t\tabc\t", "%R\t4\t1\t7\t2026-05-01 17:00\t\t",
           "%R\t5\t1\t7\t\t\tignored", "%R\t6\t1\t7\t\t9\t", "%R\t8\t1\t7\t\t\tINDICATOR_RED", "%R\t9\t1\t7\t\t\tq",
           "%R\t1\t99\t7\t\t\tno such task", "%R\t3\t1\t7\t\t\t", "%R\t77\t1\t7\t\t\tno such type", "%R\t1\t1\t7\t\t\tAcme twice")
    raw.append(("crafted-user-fields", _minimal(extra=udf).encode(), None))
    # lag calendars: SCHEDOPTIONS.sched_calendar_on_relationship_lag written for every option, then crafted rows
    for mode in (None, "predecessor", "successor", "project", "24h"):
        raw.append((f"written-lag_calendar-{mode or 'default'}", _xer({**links_and_lags(), "lag_calendar": mode}), None))
    so = lambda *rows: ("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tproj_id\tsched_calendar_on_relationship_lag", *rows)  # noqa: E731
    raw.append(("crafted-schedoptions-other-project-first", _minimal(extra=so("%R\t1\t8\trcal_Successor", "%R\t2\t7\trcal_24Hour", "%R\t3\t7\trcal_Project")).encode(), None))
    raw.append(("crafted-schedoptions-unknown-value", _minimal(extra=so("%R\t1\t7\trcal_Lunar")).encode(), None))
    raw.append(("crafted-schedoptions-blank-value", _minimal(extra=so("%R\t1\t7\t")).encode(), None))
    raw.append(("crafted-schedoptions-no-proj-id-column", _minimal(extra=("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tsched_calendar_on_relationship_lag", "%R\t1\trcal_Project")).encode(), None))
    raw.append(("crafted-schedoptions-no-lag-column", _minimal(extra=("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tproj_id", "%R\t1\t7")).encode(), None))
    raw.append(("crafted-schedoptions-no-rows", _minimal(extra=so()).encode(), None))
    raw.append(("crafted-schedoptions-short-row", _minimal(extra=so("%R\t1")).encode(), None))
    # progress logic: SCHEDOPTIONS.sched_retained_logic / sched_progress_override written for every option, then crafted rows
    for mode in (None, "data_date", "retained", "override", "bogus"):
        raw.append((f"written-progress_logic-{mode or 'default'}", _xer({**progress(), "progress_logic": mode}), None))
    pl = lambda *rows: ("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tproj_id\tsched_retained_logic\tsched_progress_override", *rows)  # noqa: E731
    for name, flags in (("retained", "Y\tN"), ("override", "N\tY"), ("actual-dates", "N\tN"), ("both-y", "Y\tY"), ("blank", "\t"),
                        ("retained-n-only", "N\t"), ("override-n-only", "\tN"), ("lowercase", "n\ty"), ("garbage", "maybe\t1")):
        raw.append((f"crafted-progress_logic-{name}", _minimal(extra=pl(f"%R\t1\t7\t{flags}")).encode(), None))
    raw.append(("crafted-progress_logic-other-project-first", _minimal(extra=pl("%R\t1\t8\tN\tY", "%R\t2\t7\tN\tN", "%R\t3\t7\tN\tY")).encode(), None))
    raw.append(("crafted-progress_logic-no-proj-id-column", _minimal(extra=("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tsched_retained_logic\tsched_progress_override", "%R\t1\tN\tY")).encode(), None))
    raw.append(("crafted-progress_logic-override-column-only", _minimal(extra=("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tproj_id\tsched_progress_override", "%R\t1\t7\tY")).encode(), None))
    raw.append(("crafted-progress_logic-retained-column-only", _minimal(extra=("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tproj_id\tsched_retained_logic", "%R\t1\t7\tN")).encode(), None))
    raw.append(("crafted-progress_logic-use-actual-dates-column", _minimal(extra=("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tproj_id\tsched_retained_logic\tsched_progress_override\tsched_use_actual_dates", "%R\t1\t7\tY\tN\tY")).encode(), None))
    raw.append(("crafted-progress_logic-with-lag-calendar", _minimal(extra=("%T\tSCHEDOPTIONS", "%F\tschedoptions_id\tproj_id\tsched_retained_logic\tsched_calendar_on_relationship_lag\tsched_progress_override", "%R\t1\t7\tN\trcal_24Hour\tN")).encode(), None))
    raw.append(("written-constraints-unscheduled", _xer(constraints(), scheduled=False), None))
    raw.append(("written-logic_loop", _xer(logic_loop(), scheduled=False), None))
    raw.append(("non-ascii-cp1252", _xer(_non_ascii(), encoding="cp1252"), None))
    raw.append(("non-ascii-utf8", _xer(_non_ascii()), None))
    raw.append(("non-ascii-utf8-bom", b"\xef\xbb\xbf" + _xer(_non_ascii()), None))
    undefined = _xer(_non_ascii(), encoding="cp1252").replace("Café façade".encode("cp1252"), b"Caf\x81\x8d\x8f\x90\x9d\xe9")
    raw.append(("non-ascii-cp1252-undefined-bytes", undefined, None))
    crafted = _crafted()
    raw.append(("crafted-crlf-utf8", crafted.encode("utf-8"), None))
    raw.append(("crafted-cp1252", crafted.encode("cp1252"), None))
    raw.append(("crafted-lf-other-line-breaks", crafted.replace("\r\n", "\n").replace("%T\tRSRC\n", "%T\tRSRC\x0c")
                .replace("%T\tTASKRSRC\n", "%T\tTASKRSRC\u2028").encode("utf-8"), None))
    raw.append(("minimal-missing-default-calendar", _minimal().encode(), None))
    raw.append(("minimal-no-calendar-at-all", _minimal(("%R\t7\tMINI\t\t\t2026-03-02 08:00\t",)).encode(), None))
    raw.append(("minimal-duplicate-codes", _minimal(extra=("%R\t3\t7\tM10\tDuplicate code\t8",)).encode(), None))
    multi = _minimal(("%R\t7\tMINI\t77\t\t2026-03-02 08:00\tN", "%R\t8\tSECOND\t\t\t2026-04-06 08:00\tN",
                      "%R\t9\tTHIRD\t\t\t2026-05-04 08:00\tN"))
    raw.append(("random-calendars", _minimal(extra=(_random_calendars(),)).encode(), None))
    night = _minimal(extra=("%T\tCALENDAR", "%F\tclndr_id\tclndr_name\tclndr_data", f"%R\t77\tNights\t{CAL_NIGHT}"))
    raw.append(("night-shift-calendar", night.replace("Only task\t40", "Only task\t0").encode(), None))
    for idx in (None, 1, 5, -1, -3, -4):
        raw.append((f"multi-project-index-{idx}", multi.encode(), idx))
    for name, data in _malformed():
        raw.append((f"malformed-{name}", data, None))
    return [(n, {"data": base64.b64encode(b).decode("ascii"), "index": idx}) for n, b, idx in raw]


# ----------------------------------------------------------------------------------------
# the Python side (mirrors tests/parity/xer_runner.js)
# ----------------------------------------------------------------------------------------
def _decode(data: bytes) -> str:
    """planner.io.read_any's decoding of .xer bytes."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def run_py(c: dict) -> dict:
    data = base64.b64decode(c["data"])
    text = _decode(data)
    out: dict = {"text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    try:
        p = read_any("case.xer", data) if c["index"] is None else read_xer(text, c["index"])
    except Exception as e:  # noqa: BLE001 - the error text itself is compared
        out["error"] = str(e)
        return out
    out["read"] = p.model_dump(mode="json")
    try:
        schedule(p)
        out["project"] = p.model_dump(mode="json")
    except Exception as e:  # noqa: BLE001
        out["schedule_error"] = str(e)
    return out


CASES = build_cases()

# Cases that read identically but then schedule differently because of a gap in web/engine.js, not
# in the reader. Their read result and errors must still agree; only the scheduled project may differ.
ENGINE_GAPS: dict[str, str] = {}   # night-shift gap closed: both engines now step back to 23:59:59


@pytest.fixture(scope="module")
def py_results():
    return [norm(run_py(c)) for _, c in CASES]


@pytest.fixture(scope="module", params=TIMEZONES)
def js_results(request):
    payload = json.dumps({"cases": [c for _, c in CASES]})
    res = subprocess.run([NODE, str(RUNNER)], input=payload, capture_output=True, text=True,
                         env={**os.environ, "TZ": request.param}, timeout=300)
    assert res.returncode == 0, res.stderr
    return request.param, [norm(r) for r in json.loads(res.stdout)]


@pytest.mark.parametrize("idx", range(len(CASES)), ids=[n for n, _ in CASES])
def test_xer_import_agrees(idx, py_results, js_results):
    tz, js = js_results
    name = CASES[idx][0]
    d = diff(py_results[idx], js[idx])
    if d and name in ENGINE_GAPS:
        read_only = lambda r: {k: v for k, v in r.items() if k != "project"}  # noqa: E731
        assert not diff(read_only(py_results[idx]), read_only(js[idx])), d
        pytest.xfail(ENGINE_GAPS[name])
    assert not d, f"{CASES[idx][0]} under TZ={tz}: {len(d)}+ differences\n  " + "\n  ".join(d)


def test_xer_version_cases_differ_in_the_header_only():
    base = _xer(progress()).decode().splitlines()
    assert base[0].split("\t")[1] == "19.12"
    for v, stamp in (("15.2", "15.2"), ("19", "19.12"), ("21", "21.12"), ("24", "24.12"), ("8.4", "8.4"), ("99.9", "99.9")):
        lines = _xer(progress(), version=v).decode().splitlines()
        assert lines[0].split("\t")[1] == stamp, v
        assert lines[1:] == base[1:], v


def test_corpus_reaches_the_reader():
    """Guard against a corpus that silently stops exercising the reader: most cases must read
    and schedule, and the malformed ones must fail with Python's own messages."""
    res = {n: run_py(c) for n, c in CASES}
    ok = [n for n, r in res.items() if "project" in r]
    assert len(ok) >= 30, ok
    errors = {n: r["error"] for n, r in res.items() if "error" in r}
    assert errors["malformed-empty"] == "XER has no PROJECT table"
    assert errors["malformed-table-without-name"] == "list index out of range"
    assert errors["malformed-project-without-proj_id"] == "'proj_id'"
    assert errors["malformed-calendar-hour-25"] == "hour must be in 0..23"
    # the progress-logic flags: only P6 progress override is read back; retained logic (P6's default, and what the
    # writer emits for None, data_date and retained) and actual dates leave the option unset
    logic = {n: r["read"].get("progress_logic") for n, r in res.items() if "progress_logic" in n}
    assert logic["written-progress_logic-default"] is None and logic["written-progress_logic-data_date"] is None
    assert logic["written-progress_logic-retained"] is None and logic["written-progress_logic-bogus"] is None
    assert logic["written-progress_logic-override"] == "override"
    assert logic["crafted-progress_logic-retained"] is None and logic["crafted-progress_logic-override"] == "override"
    assert logic["crafted-progress_logic-actual-dates"] is None and logic["crafted-progress_logic-both-y"] == "override"
    assert logic["crafted-progress_logic-blank"] is None and logic["crafted-progress_logic-retained-n-only"] is None
    assert logic["crafted-progress_logic-lowercase"] is None and logic["crafted-progress_logic-other-project-first"] is None
    assert logic["crafted-progress_logic-no-proj-id-column"] == "override" and logic["crafted-progress_logic-override-column-only"] == "override"
    assert logic["crafted-progress_logic-retained-column-only"] is None and logic["crafted-progress_logic-use-actual-dates-column"] is None
    assert logic["crafted-progress_logic-with-lag-calendar"] is None and res["crafted-progress_logic-with-lag-calendar"]["read"]["lag_calendar"] == "24h"
    for n in ("written-progress_logic-default", "written-progress_logic-data_date", "written-progress_logic-retained"):
        assert "\tY\tN\t" in _decode(base64.b64decode(dict(CASES)[n]["data"])).split("%T\tSCHEDOPTIONS")[1].split("%T")[0]
    assert not any(n.startswith(("fixture-", "written-", "non-ascii-", "crafted-")) for n in errors), errors
