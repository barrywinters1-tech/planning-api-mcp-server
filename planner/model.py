"""Core schedule data model. Durations and lags are stored in hours."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class LinkType(str, Enum):
    FS = "FS"
    SS = "SS"
    FF = "FF"
    SF = "SF"


class ActivityType(str, Enum):
    TASK = "task"
    START_MILESTONE = "start_milestone"
    FINISH_MILESTONE = "finish_milestone"
    LOE = "level_of_effort"


class Status(str, Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    COMPLETE = "complete"


class Constraint(str, Enum):
    NONE = "none"
    START_ON_OR_AFTER = "start_on_or_after"      # P6 CS_MSOA, MSP SNET
    START_ON_OR_BEFORE = "start_on_or_before"    # P6 CS_MSOB, MSP SNLT
    FINISH_ON_OR_AFTER = "finish_on_or_after"    # P6 CS_MEOA, MSP FNET
    FINISH_ON_OR_BEFORE = "finish_on_or_before"  # P6 CS_MEOB, MSP FNLT
    MUST_START_ON = "must_start_on"              # P6 CS_MSO, MSP MSO
    MUST_FINISH_ON = "must_finish_on"            # P6 CS_MEO, MSP MFO
    AS_LATE_AS_POSSIBLE = "as_late_as_possible"  # P6 CS_ALAP, MSP ALAP


HARD_CONSTRAINTS = {Constraint.MUST_START_ON, Constraint.MUST_FINISH_ON}


class Calendar(BaseModel):
    """Working-time calendar. Each working day is one contiguous shift."""

    id: str
    name: str = "Standard"
    hours_per_day: float = 8.0
    day_start: time = time(8, 0)
    working_days: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])  # Mon=0
    exceptions: dict[date, float] = Field(default_factory=dict)  # date -> hours (0 = non-working)

    # ---- working-time arithmetic -------------------------------------------------
    def hours_on(self, d: date) -> float:
        if d in self.exceptions:
            return self.exceptions[d]
        return self.hours_per_day if d.weekday() in self.working_days else 0.0

    def is_working(self, d: date) -> bool:
        return self.hours_on(d) > 0

    def _shift(self, d: date) -> tuple[datetime, datetime]:
        start = datetime.combine(d, self.day_start)
        return start, start + timedelta(hours=self.hours_on(d))

    def next_working_start(self, dt: datetime) -> datetime:
        """Roll dt forward to the next moment work can happen (inclusive)."""
        d = dt.date()
        for _ in range(3660):
            if self.is_working(d):
                s, e = self._shift(d)
                if dt < s:
                    return s
                if dt < e:
                    return dt
            d += timedelta(days=1)
            dt = datetime.combine(d, time.min)
        raise ValueError(f"Calendar {self.id} has no working time in the next 10 years")

    def prev_working_end(self, dt: datetime) -> datetime:
        """Roll dt backward to the last moment work can happen (inclusive)."""
        d = dt.date()
        for _ in range(3660):
            if self.is_working(d):
                s, e = self._shift(d)
                if dt > e:
                    return e
                if dt > s:
                    return dt
                if dt == s and self.is_working(d - timedelta(days=1)) and self._shift(d - timedelta(days=1))[1] == s:
                    return dt   # continuous (24-hour) calendars: the previous day's shift ends exactly here
            d -= timedelta(days=1)
            dt = datetime.combine(d, time(23, 59, 59))
        raise ValueError(f"Calendar {self.id} has no working time in the previous 10 years")

    def in_shift(self, dt: datetime) -> bool:
        if not self.is_working(dt.date()):
            return False
        s, e = self._shift(dt.date())
        return s <= dt <= e

    def add_hours(self, dt: datetime, hours: float) -> datetime:
        """Add working hours to dt (negative hours subtract).

        Results land on whole seconds (the final partial-day offset is rounded half-to-even),
        so schedules never carry microsecond noise and the browser engine, which has
        millisecond Dates, computes bit-identical dates."""
        if hours == 0:
            return dt
        if hours > 0:
            dt = self.next_working_start(dt)
            remaining = hours
            while True:
                s, e = self._shift(dt.date())
                avail = (e - dt).total_seconds() / 3600
                if remaining <= avail + 1e-9:
                    return dt + timedelta(seconds=round(remaining * 3600))
                remaining -= avail
                dt = self.next_working_start(datetime.combine(dt.date() + timedelta(days=1), time.min))
        else:
            dt = self.prev_working_end(dt)
            d = dt.date()
            if dt == self._shift(d)[0]:
                d -= timedelta(days=1)   # midnight on a continuous (24-hour) calendar is the end of the previous day's shift
            remaining = -hours
            while True:
                s, e = self._shift(d)
                avail = (dt - s).total_seconds() / 3600
                if remaining <= avail + 1e-9:
                    return dt - timedelta(seconds=round(remaining * 3600))
                remaining -= avail
                d -= timedelta(days=1)
                for _ in range(3660):
                    if self.is_working(d):
                        break
                    d -= timedelta(days=1)
                else:
                    raise ValueError(f"Calendar {self.id} has no working time in the previous 10 years")
                dt = self._shift(d)[1]   # the previous working day's end

    def hours_between(self, a: datetime, b: datetime) -> float:
        """Working hours from a to b (negative if b < a)."""
        if b < a:
            return -self.hours_between(b, a)
        total = 0.0
        d = a.date()
        while d <= b.date():
            if self.is_working(d):
                s, e = self._shift(d)
                lo, hi = max(s, a), min(e, b)
                if hi > lo:
                    total += (hi - lo).total_seconds() / 3600
            d += timedelta(days=1)
        return total

    def days_to_hours(self, days: float) -> float:
        return days * self.hours_per_day

    def hours_to_days(self, hours: float) -> float:
        return hours / self.hours_per_day if self.hours_per_day else 0.0


class WBSNode(BaseModel):
    id: str
    name: str
    parent_id: Optional[str] = None
    code: Optional[str] = None
    seq: int = 0


class Relationship(BaseModel):
    predecessor_id: str
    successor_id: str
    type: LinkType = LinkType.FS
    lag_hours: float = 0.0
    lag_calendar: Optional[str] = None  # per-link override of Project.lag_calendar (same values); None = project setting
    driving: bool = False  # computed by schedule(): this link sets its successor's date


class Resource(BaseModel):
    id: str
    name: str
    type: str = "labour"  # labour | material | equipment
    unit: str = "h"
    rate: float = 0.0                              # cost per unit (per hour for labour)
    max_units_per_day: Optional[float] = None      # people (or units) available per day; None = unlimited
    colour: Optional[str] = None


class Assignment(BaseModel):
    activity_id: str
    resource_id: str
    units: float = 0.0        # total quantity (hours for labour)
    cost: float = 0.0         # planned cost; 0 = derive from units x rate
    actual_cost: float = 0.0


class Baseline(BaseModel):
    name: str
    saved_at: datetime
    dates: dict[str, dict] = Field(default_factory=dict)  # activity id -> {start, finish, duration_hours}
    finish: Optional[datetime] = None


class Activity(BaseModel):
    id: str
    name: str
    wbs_id: Optional[str] = None
    calendar_id: Optional[str] = None
    type: ActivityType = ActivityType.TASK
    duration_hours: float = 0.0
    constraint: Constraint = Constraint.NONE
    constraint_date: Optional[datetime] = None
    deadline: Optional[datetime] = None                   # target finish (MS Project deadline): shown, filtered, never drives dates
    elapsed: Optional[bool] = None                        # elapsed duration: runs on calendar time (24h, 7 days) whatever its calendar (curing, drying, lead times); see cpm.ELAPSED_CALENDAR
    # progress
    status: Status = Status.NOT_STARTED
    actual_start: Optional[datetime] = None
    actual_finish: Optional[datetime] = None
    suspend_date: Optional[datetime] = None   # P6 suspend: work on an in-progress activity stopped here
    resume_date: Optional[datetime] = None    # remaining work restarts here (never before the data date)
    remaining_hours: Optional[float] = None
    percent_complete: float = 0.0
    # baseline
    baseline_start: Optional[datetime] = None
    baseline_finish: Optional[datetime] = None
    # computed by schedule()
    early_start: Optional[datetime] = None
    early_finish: Optional[datetime] = None
    late_start: Optional[datetime] = None
    late_finish: Optional[datetime] = None
    total_float_hours: Optional[float] = None
    free_float_hours: Optional[float] = None
    critical: bool = False
    near_critical: Optional[bool] = None  # open, off the longest path, total float <= Project.near_critical_days (10 when unset); None until scheduled
    float_path: Optional[int] = None      # P6 multiple float paths: 1 = longest path, 2.. the next most critical chains; None when not computed / not on a path
    notes: str = ""
    # classification and levelling
    codes: dict[str, str] = Field(default_factory=dict)   # code type -> value, e.g. {"Trade": "Bricklayers"}
    fields: Optional[dict[str, Any]] = None                # user-defined fields: name -> value (text, number or YYYY-MM-DD)
    priority: int = 500                                   # levelling priority, lower = first (P6 convention)
    level_delay_hours: float = 0.0                        # set by resource levelling

    @property
    def is_milestone(self) -> bool:
        return self.type in (ActivityType.START_MILESTONE, ActivityType.FINISH_MILESTONE)

    @property
    def start(self) -> Optional[datetime]:
        return self.actual_start or self.early_start

    @property
    def finish(self) -> Optional[datetime]:
        return self.actual_finish or self.early_finish


class Project(BaseModel):
    id: str
    name: str
    start: datetime
    data_date: Optional[datetime] = None
    must_finish_by: Optional[datetime] = None
    default_calendar_id: str = "std"
    # calendar the lag of a relationship is measured on: "predecessor" (P6 default, also when None),
    # "successor", "project" (the default calendar) or "24h" (elapsed wall-clock hours)
    lag_calendar: Optional[str] = None
    # how an in-progress activity's remaining work is scheduled (P6 "when scheduling progressed activities use"):
    # "data_date" (the engine default, also when None), "retained" (P6 retained logic) or "override" (P6 progress override); see cpm.schedule
    progress_logic: Optional[str] = None
    float_paths: Optional[int] = None          # number of P6-style float paths (1-10) to compute after scheduling; None = none
    start_on_new_day: Optional[bool] = None    # Asta "start on new day": a not-started activity never starts part-way through a working day
    near_critical_days: Optional[float] = None  # working days of total float at or below which an open activity is near-critical (10 when None)
    currency: Optional[str] = None  # ISO code or symbol for money shown in the app and on reports (GBP when None)
    levelling: Optional[dict] = None           # resource levelling options (levelling.level docstring): resources, from, to, within_float, order, preserve_actuals
    levelling_report: Optional[list] = None    # set by level(): [{id, delay_hours, resource_id, waited_for, reason}] by id; None until levelled
    check_thresholds: Optional[dict] = None    # a planner's edits to the health-check thresholds (dcma.health_check), by threshold key
    check_set: Optional[str] = None            # which check set the programme is scored against in the app: 'dcma' (when None) or 'pp21'
    calendars: dict[str, Calendar] = Field(default_factory=dict)
    wbs: list[WBSNode] = Field(default_factory=list)
    activities: list[Activity] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)
    resources: list[Resource] = Field(default_factory=list)
    assignments: list[Assignment] = Field(default_factory=list)
    description: str = ""
    assumptions: list[str] = Field(default_factory=list)
    code_types: dict[str, dict[str, str]] = Field(default_factory=dict)  # type -> {value: colour}
    baselines: list[Baseline] = Field(default_factory=list)
    revisions: list[dict] = Field(default_factory=list)   # issued versions: {name, issued_at, note, project}
    annotations: Optional[list[dict]] = None              # chart notes: {id, date, activity_id|None, text}
    progress_periods: Optional[list[dict]] = None         # closed periods: {id, name, data_date, closed_at, pct, planned_pct, finish, acts{id: [start, finish, pct, n|p|c]}}
    user_fields: Optional[list[dict]] = None              # user-defined field definitions: {name, type: text|number|date}
    views: Optional[list[dict]] = None                    # saved views stored with the programme: {name, cols, widths, view, panel}
    filters: Optional[list[dict]] = None                  # saved filters: {name, text} in the table-filter grammar
    shading: Optional[list[dict]] = None                  # chart date-range bands: {id, from, to, label, colour}
    changes: Optional[list[dict]] = None                  # change log: {id, at, label, reason, finish_days, moved: [{id, name, days, from, to}]}
    accepted_baseline: Optional[str] = None               # the baseline the client accepted (name), shown in the briefing and on issue
    levelled: bool = False
    # computed
    finish: Optional[datetime] = None
    scheduled_at: Optional[datetime] = None

    # ---- helpers ------------------------------------------------------------------
    def calendar_for(self, act: Activity) -> Calendar:
        cid = act.calendar_id or self.default_calendar_id
        cal = self.calendars.get(cid)
        if cal is None:
            cal = self.calendars.get(self.default_calendar_id)
        if cal is None:
            cal = Calendar(id=self.default_calendar_id)
            self.calendars[cal.id] = cal
        return cal

    def activity(self, act_id: str) -> Activity:
        for a in self.activities:
            if a.id == act_id:
                return a
        raise KeyError(f"No activity {act_id!r}")

    def activity_map(self) -> dict[str, Activity]:
        return {a.id: a for a in self.activities}

    def predecessors_of(self, act_id: str) -> list[Relationship]:
        return [r for r in self.relationships if r.successor_id == act_id]

    def successors_of(self, act_id: str) -> list[Relationship]:
        return [r for r in self.relationships if r.predecessor_id == act_id]

    def export_relationships(self) -> tuple[list[Relationship], list[Relationship]]:
        """(kept, dropped): P6 and MS Project allow one link between two activities; this model allows
        several (an SS+FF ladder). Keep the driving link of each pair (the first if none drives)."""
        best: dict[tuple[str, str], Relationship] = {}
        for r in self.relationships:
            k = (r.predecessor_id, r.successor_id)
            if k not in best or (r.driving and not best[k].driving):
                best[k] = r
        keep = {id(r) for r in best.values()}
        return [r for r in self.relationships if id(r) in keep], [r for r in self.relationships if id(r) not in keep]

    def ensure_default_calendar(self) -> Calendar:
        if self.default_calendar_id not in self.calendars:
            self.calendars[self.default_calendar_id] = Calendar(id=self.default_calendar_id)
        return self.calendars[self.default_calendar_id]
