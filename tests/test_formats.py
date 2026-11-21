from datetime import date, datetime

from planner import (Activity, ActivityType, Assignment, Calendar, Constraint, LinkType, Project,
                     Relationship, Resource, Status, WBSNode, schedule)
from planner.xer import read_xer, write_xer, parse_clndr_data, build_clndr_data
from planner.mspxml import read_mspdi, write_mspdi


def sample() -> Project:
    cal = Calendar(id="std", name="5d x 8h", exceptions={date(2026, 12, 25): 0.0})
    six = Calendar(id="six", name="6d x 10h", hours_per_day=10, working_days=[0, 1, 2, 3, 4, 5])
    p = Project(id="DEMO", name="Demo build", start=datetime(2026, 1, 5, 8), data_date=datetime(2026, 1, 5, 8),
                calendars={"std": cal, "six": six}, must_finish_by=datetime(2026, 3, 31, 16))
    p.wbs = [WBSNode(id="W1", name="Enabling", seq=1), WBSNode(id="W2", name="Substructure", seq=2),
             WBSNode(id="W21", name="Piling", parent_id="W2", seq=1)]
    p.activities = [
        Activity(id="A1000", name="Start", type=ActivityType.START_MILESTONE, wbs_id="W1"),
        Activity(id="A1010", name="Site set-up", duration_hours=40, wbs_id="W1"),
        Activity(id="A1020", name="Piling", duration_hours=80, wbs_id="W21", calendar_id="six"),
        Activity(id="A1030", name="Pile caps", duration_hours=40, wbs_id="W2",
                 constraint=Constraint.START_ON_OR_AFTER, constraint_date=datetime(2026, 2, 2, 8)),
        Activity(id="A1040", name="Substructure complete", type=ActivityType.FINISH_MILESTONE, wbs_id="W2"),
    ]
    p.relationships = [
        Relationship(predecessor_id="A1000", successor_id="A1010"),
        Relationship(predecessor_id="A1010", successor_id="A1020", type=LinkType.SS, lag_hours=16),
        Relationship(predecessor_id="A1020", successor_id="A1030", type=LinkType.FS, lag_hours=8),
        Relationship(predecessor_id="A1030", successor_id="A1040"),
    ]
    p.resources = [Resource(id="PILER", name="Piling gang", type="labour"), Resource(id="RIG", name="Piling rig", type="equipment")]
    p.assignments = [Assignment(activity_id="A1020", resource_id="PILER", units=160), Assignment(activity_id="A1020", resource_id="RIG", units=80)]
    schedule(p)
    return p


def _assert_same(a: Project, b: Project, floats: bool = True):
    assert [x.id for x in a.activities] == [x.id for x in b.activities]
    for x, y in zip(a.activities, b.activities):
        assert x.name == y.name
        assert x.type == y.type
        assert x.duration_hours == y.duration_hours
        assert x.constraint == y.constraint
        assert x.constraint_date == y.constraint_date
    assert sorted((r.predecessor_id, r.successor_id, r.type, r.lag_hours) for r in a.relationships) == \
           sorted((r.predecessor_id, r.successor_id, r.type, r.lag_hours) for r in b.relationships)
    assert sorted(r.id for r in a.resources) == sorted(r.id for r in b.resources)
    assert len(a.assignments) == len(b.assignments)
    # rescheduling the round-tripped project gives the same dates
    schedule(b)
    for x, y in zip(a.activities, b.activities):
        assert x.early_start == y.early_start, x.id
        assert x.early_finish == y.early_finish, x.id
        if floats:
            assert x.total_float_hours == y.total_float_hours, x.id


def test_xer_roundtrip():
    p = sample()
    text = write_xer(p)
    assert text.startswith("ERMHDR")
    assert "%T\tTASK" in text and "%T\tTASKPRED" in text
    q = read_xer(text)
    assert q.name == "Demo build"
    assert q.must_finish_by == p.must_finish_by
    assert {c.name for c in q.calendars.values()} == {"5d x 8h", "6d x 10h"}
    six = next(c for c in q.calendars.values() if c.name == "6d x 10h")
    assert six.working_days == [0, 1, 2, 3, 4, 5] and six.hours_per_day == 10
    std = next(c for c in q.calendars.values() if c.name == "5d x 8h")
    assert std.exceptions.get(date(2026, 12, 25)) == 0.0
    assert {w.name for w in q.wbs} == {"Enabling", "Substructure", "Piling"}
    piling = next(w for w in q.wbs if w.name == "Piling")
    assert next(w for w in q.wbs if w.id == piling.parent_id).name == "Substructure"
    _assert_same(p, q)


def test_clndr_data_parse_real_shape():
    blob = ("(0||CalendarType()( 0||DaysOfWeek()( 0||1()( ) 0||2()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) "
            "0||3()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) 0||4()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) "
            "0||5()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) 0||6()( 0||0(s|08:00|f|12:00) 0||1(s|13:00|f|17:00) ) "
            "0||7()( ) ) 0||VIEW(ShowTotal|Y)() 0||Exceptions()( 0||0(d|46016)( ) 0||1(d|46017)( 0||0(s|08:00|f|12:00) ) ) ))")
    cal = parse_clndr_data(blob, Calendar(id="x"))
    assert cal.working_days == [0, 1, 2, 3, 4]
    assert cal.hours_per_day == 8
    assert cal.day_start.hour == 8
    assert cal.exceptions[date(2025, 12, 25)] == 0.0
    assert cal.exceptions[date(2025, 12, 26)] == 4.0
    again = parse_clndr_data(build_clndr_data(cal), Calendar(id="y"))
    assert again.working_days == cal.working_days and again.exceptions == cal.exceptions


def test_mspdi_roundtrip():
    p = sample()
    text = write_mspdi(p)
    assert "<PredecessorLink>" in text
    q = read_mspdi(text)
    assert q.name == "Demo build"
    assert {w.name for w in q.wbs} == {"Enabling", "Substructure", "Piling"}
    _assert_same(p, q, floats=False)  # MSPDI has no must-finish-by, so late dates differ


def test_mspdi_progress_survives():
    p = sample()
    a = p.activity("A1010")
    a.status, a.actual_start, a.percent_complete, a.remaining_hours = Status.IN_PROGRESS, datetime(2026, 1, 5, 8), 50, 20
    p.data_date = datetime(2026, 1, 8, 8)
    schedule(p)
    q = read_mspdi(write_mspdi(p))
    b = q.activity("A1010")
    assert b.status == Status.IN_PROGRESS and b.actual_start == a.actual_start and b.remaining_hours == 20
    q2 = read_xer(write_xer(p))
    c = q2.activity("A1010")
    assert c.status == Status.IN_PROGRESS and c.remaining_hours == 20


def test_duplicate_pair_links_export_as_the_driving_one():
    """P6 and MS Project allow one link per pair; an SS+FF ladder exports as its driving link."""
    from datetime import datetime
    from planner import Activity, LinkType, Project, Relationship, schedule
    from planner.mspxml import read_mspdi, write_mspdi
    from planner.xer import read_xer, write_xer
    p = Project(id="T", name="T", start=datetime(2026, 1, 5, 8)); p.ensure_default_calendar()
    p.activities = [Activity(id="A", name="A", duration_hours=40), Activity(id="B", name="B", duration_hours=24)]
    p.relationships = [Relationship(predecessor_id="A", successor_id="B", type=LinkType.SS, lag_hours=8),
                       Relationship(predecessor_id="A", successor_id="B", type=LinkType.FF, lag_hours=8)]
    schedule(p)
    kept, dropped = p.export_relationships()
    assert [r.type for r in kept] == [LinkType.FF] and [r.type for r in dropped] == [LinkType.SS]
    assert [r.type for r in read_mspdi(write_mspdi(p)).relationships] == [LinkType.FF]
    assert [r.type for r in read_xer(write_xer(p)).relationships] == [LinkType.FF]


def test_xer_carries_activity_notes():
    from datetime import datetime
    from planner import Activity, Project, schedule
    from planner.xer import read_xer, write_xer
    p = Project(id="N", name="N", start=datetime(2026, 1, 5, 8)); p.ensure_default_calendar()
    p.activities = [Activity(id="A", name="A", duration_hours=8, notes="Line one\nCafé £5 & <b>x</b>")]
    schedule(p)
    text = write_xer(p)
    assert "%T\tTASKMEMO" in text and "%T\tMEMOTYPE" in text
    assert read_xer(text).activities[0].notes == "Line one\nCafé £5 & <b>x</b>"


def test_progress_periods_and_chart_notes_survive_json_roundtrip():
    p = sample()
    p.annotations = [{"id": "N1", "date": "2026-03-04T08:00:00", "activity_id": None, "text": "Crane booked"}]
    p.progress_periods = [{"id": "P1", "name": "Period 1", "data_date": "2026-03-09T08:00:00", "closed_at": "2026-03-09T17:00:00",
                           "pct": 6.0, "planned_pct": 6.0, "finish": "2026-10-05T16:00:00", "acts": {"A": ["2026-03-02T08:00", "2026-03-06T16:00", 100, "c"]}}]
    back = Project.model_validate_json(p.model_dump_json())
    assert back.progress_periods == p.progress_periods
    assert back.annotations == p.annotations
    assert Project.model_validate_json(sample().model_dump_json()).progress_periods is None


def _with_fields(codes: bool = False) -> Project:
    p = sample()
    p.user_fields = [{"name": "Package", "type": "text"}, {"name": "Cost", "type": "number"}, {"name": "Due", "type": "date"}]
    p.activities[0].fields = {"Package": "Steel\tframe", "Cost": 1200.0, "Due": "2026-04-01"}
    p.activities[1].fields = {"Cost": 12.5, "Extra": "x", "Blank": ""}
    if codes:
        p.code_types = {"Trade": {"Brick": "#ff0000"}, "Zone": {}}
        p.activities[2].codes = {"Trade": "Brick", "Zone": "North"}
        p.activities[3].codes = {"Trade": "Steel", "Phase": "P2"}
    return p


def _node(js: str, stdin: str) -> str:
    """Run a snippet against web/engine.js and the file readers; skips the test when node is missing."""
    import shutil, subprocess
    from pathlib import Path
    import pytest
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    web = Path(__file__).resolve().parent.parent / "web"
    prelude = "".join("require(%r);" % str(web / f) for f in ("engine.js", "import_xer.js", "import_xml.js", "import_any.js"))
    prelude += "const E = globalThis.PlannerEngine; const p = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
    return subprocess.run([node, "-e", prelude + js], input=stdin, capture_output=True, text=True, check=True).stdout


def test_user_fields_written_by_both_engines_read_back_the_same():
    """XER user-defined fields: web/engine.js writes what planner/xer.py writes (read back through read_xer)."""
    p = _with_fields()
    out = _node("process.stdout.write(E.writeXer(p));", p.model_dump_json())
    a, b = read_xer(out), read_xer(write_xer(p))
    assert a.user_fields == b.user_fields
    assert [x.fields for x in a.activities] == [x.fields for x in b.activities]
    assert a.activities[0].fields == {"Package": "Steel frame", "Cost": 1200.0, "Due": "2026-04-01"}


def test_mspdi_custom_fields_roundtrip():
    """MS Project XML carries user fields as ExtendedAttributes: Text1-30, Number1-20, Date1-10 by the standard FieldIDs,
    the field name as the Alias; undeclared fields on activities are declared too; blanks are not written."""
    p = _with_fields()
    text = write_mspdi(p)
    head = text[:text.index("<Calendars>")]
    assert "<ExtendedAttributes>" in head                        # declared before the calendars, as the schema orders
    for fid, fname, alias in ((188743731, "Text1", "Package"), (188743767, "Number1", "Cost"), (188743945, "Date1", "Due"),
                              (188743734, "Text2", "Extra"), (188743737, "Text3", "Blank")):
        assert f"<FieldID>{fid}</FieldID>\n      <FieldName>{fname}</FieldName>\n      <Alias>{alias}</Alias>" in head, alias
    assert "<FieldID>188743945</FieldID>\n        <Value>2026-04-01T00:00:00</Value>" in text   # dates in MSPDI form
    assert "<FieldID>188743767</FieldID>\n        <Value>1200</Value>" in text                  # numbers as plain decimals
    assert "<Value>12.5</Value>" in text and text.count("<Value>") == 5                         # the blank is not written
    q = read_mspdi(text)
    assert q.user_fields == [{"name": "Package", "type": "text"}, {"name": "Cost", "type": "number"}, {"name": "Due", "type": "date"},
                             {"name": "Extra", "type": "text"}, {"name": "Blank", "type": "text"}]
    assert q.activities[0].fields == {"Package": "Steel\tframe", "Cost": 1200.0, "Due": "2026-04-01"}
    assert q.activities[1].fields == {"Cost": 12.5, "Extra": "x"}
    assert all(a.fields is None for a in q.activities[2:]) and q.code_types == {}
    assert read_mspdi(write_mspdi(sample())).user_fields is None
    _assert_same(p, q, floats=False)


def test_mspdi_fields_without_alias_take_the_field_name():
    xml = ('<Project xmlns="http://schemas.microsoft.com/project"><Name>P</Name><StartDate>2026-03-02T08:00:00</StartDate>'
           '<ExtendedAttributes><ExtendedAttribute><FieldID>188743731</FieldID><FieldName>Text1</FieldName></ExtendedAttribute>'
           '<ExtendedAttribute><FieldID>188743982</FieldID></ExtendedAttribute>'
           '<ExtendedAttribute><FieldID>188743945</FieldID><FieldName>Date1</FieldName><Alias>Permit</Alias></ExtendedAttribute></ExtendedAttributes>'
           '<Tasks><Task><UID>1</UID><ID>1</ID><Name>A</Name><WBS>A</WBS><OutlineLevel>1</OutlineLevel><Duration>PT8H0M0S</Duration>'
           '<ExtendedAttribute><FieldID>188743731</FieldID><Value>plain</Value></ExtendedAttribute>'
           '<ExtendedAttribute><FieldID>188743982</FieldID><Value>6.25</Value></ExtendedAttribute>'
           '<ExtendedAttribute><FieldID>188743945</FieldID><Value>2026-07-01T00:00:00</Value></ExtendedAttribute>'
           '<ExtendedAttribute><FieldID>188743954</FieldID><Value>2026-08-01T00:00:00</Value></ExtendedAttribute>'   # never declared
           '</Task></Tasks></Project>')
    p = read_mspdi(xml)
    assert p.user_fields == [{"name": "Text1", "type": "text"}, {"name": "Number6", "type": "number"}, {"name": "Permit", "type": "date"},
                             {"name": "Date10", "type": "date"}]
    assert p.activities[0].fields == {"Text1": "plain", "Number6": 6.25, "Permit": "2026-07-01", "Date10": "2026-08-01"}
    q = read_mspdi(write_mspdi(p))                                 # written back under fresh ids, read back the same
    assert q.user_fields == p.user_fields and q.activities[0].fields == p.activities[0].fields


def test_mspdi_codes_travel_as_text_fields():
    """Activity codes have no place in MSPDI: each code type is written as a text field named after it. Read plainly they
    are text fields; read with the receiving programme's code type names they are codes again."""
    p = _with_fields(codes=True)
    text = write_mspdi(p)
    head = text[:text.index("<Calendars>")]
    assert "<Alias>Trade</Alias>" in head and "<Alias>Zone</Alias>" in head and "<Alias>Phase</Alias>" in head
    q = read_mspdi(text)
    assert [d["name"] for d in q.user_fields] == ["Package", "Cost", "Due", "Extra", "Blank", "Trade", "Zone", "Phase"]
    assert q.activities[2].fields == {"Trade": "Brick", "Zone": "North"} and q.activities[2].codes == {} and q.code_types == {}
    r = read_mspdi(text, code_types=["Trade", "Zone"])
    assert [d["name"] for d in r.user_fields] == ["Package", "Cost", "Due", "Extra", "Blank", "Phase"]
    assert r.activities[2].codes == {"Trade": "Brick", "Zone": "North"} and r.activities[2].fields is None
    assert r.activities[3].codes == {"Trade": "Steel"} and r.activities[3].fields == {"Phase": "P2"}
    assert r.code_types == {"Trade": {"Brick": "#7a8aa6", "Steel": "#7a8aa6"}, "Zone": {"North": "#7a8aa6"}}
    # a user field with a code type's name wins: the code type is not written twice
    p.user_fields.append({"name": "Trade", "type": "text"})
    p.activities[0].fields["Trade"] = "as a field"
    text = write_mspdi(p)
    assert text.count("<Alias>Trade</Alias>") == 1
    assert read_mspdi(text).activities[0].fields["Trade"] == "as a field" and read_mspdi(text).activities[2].fields == {"Zone": "North"}


def test_mspdi_custom_fields_written_by_both_engines_read_back_the_same():
    """web/engine.js writeMspdi and planner/mspxml.py write the same fields and codes; each engine's file reads back the same
    in the other engine's reader, with and without code types."""
    import json
    p = _with_fields(codes=True)
    p.activities[1].fields["Number too"] = 7
    js_xml = _node("E.schedule(p); process.stdout.write(E.writeMspdi(p));", p.model_dump_json())
    py_xml = write_mspdi(p)
    assert js_xml.count("<ExtendedAttribute>") == py_xml.count("<ExtendedAttribute>") == 9 + 10   # 9 definitions, 10 values
    for code_types in (None, ["Trade", "Zone"]):
        py = [read_mspdi(t, code_types) for t in (py_xml, js_xml)]
        assert py[0].user_fields == py[1].user_fields
        assert [a.fields for a in py[0].activities] == [a.fields for a in py[1].activities]
        assert [a.codes for a in py[0].activities] == [a.codes for a in py[1].activities] and py[0].code_types == py[1].code_types
        js = [json.loads(_node("const q = E.readMspdi(p.text, p.code_types); process.stdout.write(JSON.stringify("
                               "{user_fields: q.user_fields || null, fields: q.activities.map(a => a.fields || null), codes: q.activities.map(a => a.codes), code_types: q.code_types}));",
                               json.dumps({"text": t, "code_types": code_types}))) for t in (py_xml, js_xml)]
        for r, j in zip(py, js):
            assert j["user_fields"] == r.user_fields
            assert j["fields"] == [a.fields for a in r.activities]
            assert j["codes"] == [a.codes for a in r.activities] and j["code_types"] == r.code_types
    assert py[0].activities[2].codes == {"Trade": "Brick", "Zone": "North"} and py[0].activities[1].fields == {"Cost": 12.5, "Extra": "x", "Number too": 7.0}


def test_xer_target_version():
    """write_xer(version=) / E.writeXer(p, {version}) change the ERMHDR version only; a major alone becomes P6's release
    stamp; the default stays 19.12; every version reads back."""
    from planner.xer import XER_VERSIONS, xer_version
    p = sample()
    base = write_xer(p).splitlines()
    assert base[0].split("\t")[1] == "19.12" and xer_version(None) == "19.12"
    for v, stamp in (("15.2", "15.2"), ("19", "19.12"), ("21", "21.12"), ("24", "24.12"), ("8.4", "8.4"), ("16", "16.2"), ("7.0", "7.0")):
        lines = write_xer(p, version=v).splitlines()
        assert lines[0].split("\t")[1] == stamp and lines[1:] == base[1:], v
        q = read_xer("\n".join(lines))
        assert [a.id for a in q.activities] == [a.id for a in p.activities]
        assert _node("process.stdout.write(E.writeXer(p, {version: %s}).split('\\n')[0]);" % json_str(v), p.model_dump_json()).split("\t")[1] == stamp
    assert set(XER_VERSIONS) == {"8", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24"}
    assert _node("process.stdout.write(JSON.stringify(E.XER_VERSIONS));", "{}") == __import__("json").dumps(XER_VERSIONS, separators=(",", ":"))
    assert _node("process.stdout.write(E.writeAny(p, 'xer', {version: '24'})[0].split('\\n')[0]);", p.model_dump_json()).split("\t")[1] == "24.12"


def json_str(v) -> str:
    import json
    return json.dumps(v)
