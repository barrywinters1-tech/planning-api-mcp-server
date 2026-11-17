# UK construction planners: workflow pains that apply whatever the software

Scope: recurring, tool-agnostic pains of UK construction planners and project teams in producing, updating and reporting programmes, 2020 onwards where possible.

**Read this first: where the evidence comes from and how good it is**
- **Practitioner voice is under-represented.** Reddit could not be fetched ("Claude Code is unable to fetch from www.reddit.com"). LinkedIn posts were not indexed by the search tool. Planning Planet (now redirected to projectcontrols.com) was reachable. But the threads that surfaced are mostly 2009–2011, before the 2020+ window. I use them only as evidence that a pain has persisted, and label each one with its date.
- **Most 2024–2026 search results are vendor or consultancy blogs.** Examples are necplanningsolutions.co.uk, schedulelens.com, aven-ai.com, scheduleinsight.com, buildersai.co.uk, gatherinsights.com and archdesk.com. Many of them sell NEC programme services or scheduling or AI tools. Each one is labelled **[vendor/consultancy]**.
- **The strongest independent sources:**
  - RICS *AI in Construction 2025* (more than 2,200 responses, 48% from the UK).
  - HKA (a claims consultancy, but writing analytically) on project records.
  - The Coniston Associates NEC guide, written by a construction-law consultant with more than 20 years of NEC experience.
  - Peer-reviewed or academic UK delay-claims studies.
  - The CIOB Planning Protocol 2021, as reported in *Construction Management*.

---

## Q1. What tasks take most of a planner's time, and what do planners say should be automated?

### Takeaway
The sources agree on one picture. Planners spend a growing share of the week on things other than scheduling: reformatting data, reconciling updates, writing narratives and variance explanations, and building delay or compensation-event (CE) evidence by hand. These are the tasks they name as candidates for automation. Hard UK figures on time use do not exist in the sources found. The only numbers come from vendors or unverified surveys.

### Cited Findings
- **UK blog, May 2026, no disclosed affiliation (it links to a vendor blog):**
  - "The scheduler spends a shrinking portion of the week actually scheduling"
  - "A growing portion is spent reformatting data, writing explanations, and reconciling" results against what the team believes.
  - Reconciling a variance report by hand is "data preparation", not expert work.
  - Firms are "piling more projects onto fewer schedulers and hoping the ones they have do not leave".
  - Tasks it says should be automated: schedule quality checks, variance tracking, compression monitoring, portfolio float analysis, delay documentation, narrative reporting and forecasting. In its words, "The work still needs to happen. It just does not need to happen manually."
  - Source: [UK Construction Blog – Why Schedulers Are Burning Out](https://ukconstructionblog.co.uk/2026/05/19/why-schedulers-are-burning-out-and-what-it-says-about-our-tools/)
- **Newsletter, vendor-affiliated, anecdotal:** Most schedulers lose 40+ hours a month to tasks such as tracing what changed between updates and building delay analyses in Excel. — [Beyond Deadlines newsletter](https://beyonddeadlines.beehiiv.com/p/tactics-to-save-40-hours-monthly-for-construction-schedulers)
- **"Industry report 2025" via a news site, publisher and method not traceable, probably US:**
  - Over 44% of respondents spend more than 10 hours a week on schedule reporting and reviews.
  - Only 58% are confident that this time delivers value.
  - Only 16% use AI or automation for scheduling.
  - **Treat as unverified.** Source: [ConstructionOwners.com](https://www.constructionowners.com/news/the-hidden-crisis-in-construction-why-88-of-project-schedules-are-failing)
- **NEC time burden.** Every NEC4 revised programme is a full deliverable with a fixed cadence, plus extra programmes for compensation events:
  - Clause 32.2 requires a revision when instructed, when the contractor chooses, and at "no longer interval than the interval stated in the Contract Data".
  - Clause 62.2 requires a revised programme with each compensation event quotation that affects future work.
  - Source: [Coniston Associates (Eugene Lenehan, May 2023)](https://coniston-associates.co.uk/mission-impossible-a-brief-guide-to-nec-programmes/)
- **The submission package goes well beyond the schedule file.** A formal clause 13 submission needs:
  - the schedule file
  - a PDF or print
  - a narrative of changes
  - baseline comparisons against the last accepted programme
  - the supporting documents it refers to.
  - Source **[vendor/consultancy]**: [NEC Planning Solutions – What the PM checks](https://www.necplanningsolutions.co.uk/post/what-project-manager-checks-nec-programme-review)
- **Resubmission loops absorb planner time.** One illustrative anecdote, with no data behind it: a contractor's programme is rejected at the two-week deadline, rebuilt and resubmitted. "By month four, three programmes have been submitted and none accepted." — **[vendor/consultancy]** [NEC Planning Solutions](https://www.necplanningsolutions.co.uk/post/what-project-manager-checks-nec-programme-review)
- **Corrections slip.** After a rejection for a missing clause 31.2 item, the planner means to resubmit but the fix "slips down the priority list". — **[vendor/consultancy]** via search snippet of [scheduleinsight.com](https://scheduleinsight.com/blog/nec4-programme-acceptance)
- **Skills shortage: planner-specific data is thin.**
  - A commentary on the CIOB Guide to Dynamic Time Modelling says there is "a widely recognised shortage of experienced planners relative to the scale and complexity of current projects". This is from the search snippet only; fetching the page returned 403. — [The Contracts Group, Medium](https://medium.com/@thecontractsgroup/in-the-recent-past-a-number-of-technical-publications-have-attempted-to-bring-structure-and-785c85ef9d6e)
  - RICS lists "lack of skilled personnel" as the number one barrier to AI adoption (46%). — [RICS AI in Construction 2025](https://www.rics.org/news-insights/artificial-intelligence-in-construction-report)
  - The CIOB Skills Gap Report (2025) reportedly includes planning and scheduling among professional skills gaps. No planner-specific percentage was found. — [CIOB Skills Gap Report](https://www.ciob.org/media/3179/download)
- **Labour market signal.** UK government job board adverts list contract planners at £350–£450/day (Watford) and £400–£550/day (Kent). — [Find a Job (DWP)](https://findajob.dwp.gov.uk/details/17493075) (snippet-level evidence)
- **Salary figures:**
  - Indeed: about £52.7k UK average for construction planners (132 salaries). — [Indeed UK](https://uk.indeed.com/career/construction-planner/salaries)
  - Glassdoor: about £42.6k. — [Glassdoor UK](https://www.glassdoor.co.uk/Salaries/construction-planner-salary-SRCH_KO0,20.htm)
  - Advertised median: £75k, from a sample of 30 adverts. — [projectmanagerjobs.co.uk](https://projectmanagerjobs.co.uk/construction-project-planner-salary)
- **Caution on a likely mis-citation.** Spencer Clarke's "shortage of planners" article cites an RTPI figure: 82% of local-authority planners say their employer struggled to hire. RTPI covers **town planners, not construction programme planners**. Do not use it as construction-planner evidence. — [Spencer Clarke](https://www.spencerclarkegroup.co.uk/career-hub/blog/why-is-there-a-shortage-of-planners-in-the-uk/)

### Inferences
- **The most consistently named time sinks**, from sources independent of each other:
  - reconciling and reformatting update data and explaining the variance
  - assembling NEC submission packages and narratives, and re-submitting them
  - CE and delay impact evidence, usually built in Excel
  - chasing and normalising site progress (see Q3)
- **The automation planners would accept is the analytical and reporting layer around the schedule.** That means quality checks, change detection between versions, narratives and variance reports. Automating the creation of the logic itself is a different matter (see Q5).
- **Frequency signal.** This is a rough count of how many independent sources in this research raise each pain:

| Pain | Frequency signal | Notes |
|---|---|---|
| Poor or irregular progress updating; as-built records not good enough for delay analysis | **High** (HKA; CME and ARCOM academic studies; Walter Lilly; consultancy blogs; old Planning Planet threads) | Persistent for 15+ years |
| NEC programme non-acceptance or rejection cycles, and missing clause 31.2 content | **High** (Coniston; four or more consultancy blogs; Planning Planet NEC threads; Mondaq/Fenwick Elliott on disputes) | Mostly consultancy voice |
| Master programme disconnected from site look-ahead and short-term plans; site works off WhatsApp and paper | **High** (several UK blogs; Medium/CIOB commentary; vendor pages) | Largely vendor framing; no direct planner quotes found |
| Reporting, reformatting and narrative-writing overload | **Medium** (UK blog 2026; vendor newsletter; unverified survey) | |
| Schedule quality (open ends, constraints, long durations) found at client review | **Medium** (CIOB PP21; consultancy checklists; XER tool vendors) | |
| Planner skills shortage | **Medium–low** for planner-specific data; **high** for general construction skills | |
| Which programme is current; version control | **Low–medium** (forum disputes over which programme measures delay; Premier Modular case per consultancy; vendor claims) | |
| Resource and labour loading of programmes | **Low** (Coniston: resources and method statements almost never supplied) | Little direct evidence found |

### Gaps
- No independent UK time-and-motion data or survey on how planners split their week. No CIOB or APM planner survey was found.
- No direct 2020+ UK planner quotes from Reddit or LinkedIn. Reddit was blocked and LinkedIn was not indexed.
- No confirmed planner-specific figure from the CIOB Skills Gap Report. The PDF was not fetched.

---

## Q2. Why do NEC4 programmes get rejected or disputed, and what would help?

### Takeaway
**The usual cause is non-compliance with clause 31.2, not disputed dates.** Typical omissions are float, time risk allowances, the work of others, method and resources, and Scope-specific format or milestones. The next most common causes are weak logic and unrealistic durations. Then there are "strategic" or vague rejections, and Project Managers (PMs) who stay silent or "accept with qualifications". Experienced commentators say a fully compliant programme is rare. **What would help:** a pre-submission compliance and logic check against clause 31.2 and the Scope, and a structured trail of each rejection reason and its fix.

### Cited Findings
- **The four grounds for non-acceptance (clause 31.3):**
  1. the contractor's plans are not practicable
  2. the programme does not show the information the contract requires
  3. it does not represent the contractor's plans realistically
  4. it does not comply with the Scope.
- **The PM's deadlines and the duty to give reasons:**
  - The PM has two weeks to respond.
  - If the PM fails to reply, the contractor can notify the failure. If it continues for a further week, the programme is treated as accepted (NEC4).
  - Clause 13.4 requires reasons "in sufficient detail to enable the Contractor to correct the matter".
  - Source: [Coniston Associates, May 2023](https://coniston-associates.co.uk/mission-impossible-a-brief-guide-to-nec-programmes/)
- **Coniston author (construction-law consultant, more than 20 years on NEC):**
  - "I have still never found a programme that is fully compliant with the contract."
  - On method statements and resources: "I have never seen anything close to this level of information provided with any programme". Subcontractors are often not yet procured.
  - "Project Managers can always find reasons to choose not to accept the programme."
  - On design and build: contracts are let on preliminary drawings, which limits what clause 31.2 content can be shown early.
  - "If the programme does not identify the Contractor's time risk allowances, he could lose out on their benefit."
  - Source: [Coniston Associates](https://coniston-associates.co.uk/mission-impossible-a-brief-guide-to-nec-programmes/)
- **Most frequent ground: missing clause 31.2 content.** Absent float, time risk allowances, order and timing of work, or planned dates give the PM contractual grounds. So does not showing float and time risk allowances separately. — **[vendor/consultancy]** [necplanningsolutions.co.uk clause 31 guide](https://www.necplanningsolutions.co.uk/post/nec-clause-31-programme-acceptance); [plannedltd.co.uk](https://plannedltd.co.uk/blog/nec4-programme-requirements)
- **Reasons PMs commonly give** (illustrative example, no data):
  - not practicable
  - key dates not properly shown
  - work of others unclear
  - time risk allowances not visible.
- **What PMs check in the first 15 minutes:**
  - open ends
  - logic flow
  - calendars on design activities
  - hard constraints with no contractual date behind them
  - breaks in the critical path.
- **Rejections are avoidable.** Rejected programmes "often fail on issues that could have been spotted before submission".
- **The clock starts on formal clause 13 submission, not on email receipt.**
- Sources for the four points above, all **[vendor/consultancy]**: [NEC Planning Solutions – What the PM checks](https://www.necplanningsolutions.co.uk/post/what-project-manager-checks-nec-programme-review)
- **Scope-driven failures (NEC4 added the "form stated in the Scope" requirement).** The Scope can fix the scheduling software, level of detail and format. Missing project-specific milestones is a frequent failure. — **[vendor/consultancy]** via search snippet, [gatherinsights.com](https://www.gatherinsights.com/en/nec4/programme-management) and [scheduleinsight.com](https://scheduleinsight.com/blog/nec4-programme-acceptance)
- **Rejection outside the four grounds is itself a compensation event.** A rejection on other grounds, such as disagreeing with the sequence or method, falls outside the contract and is a compensation event under clause 60.1(9). The contractor can keep working to a non-accepted programme, but a missing acceptance "WILL affect the time and cost assessments of the effect of change". — **[consultancy]** [gmhplanning NEC FAQ](https://gmhplanning.co.uk/nec-faqs/nec-programme-faq/); [necplanningsolutions – not accepted playbook](https://www.necplanningsolutions.co.uk/post/nec-programme-not-accepted)
- **"Strategic" rejections:** "in the real-world however a Contractor may have their programmes rejected for dubious 'strategic' reasons" (2018, pre-window). — [big-dada.co.uk](https://www.big-dada.co.uk/2018/04/16/planning-nec/)
- **Disputes arise from stalled acceptance and PM silence:**
  - A stalled acceptance process, especially where many subcontractors' programmes feed the main one, is "a recipe for disputes further down the line".
  - PM silence after receiving a programme has caused disputes. Under NEC3 it could leave no accepted programme at all.
  - Sources: [Mondaq – NEC Accepted Programmes: A Practical Guide](https://www.mondaq.com/uk/construction-planning/1219200/nec-accepted-programmes-a-practical-guide); [Fenwick Elliott – NEC4: A Dispute Resolution Perspective](https://www.fenwickelliott.com/research-insight/newsletters/insight/75)
- **Recent case, via one consultancy write-up only:**
  - The High Court (reported June 2026) refused to enforce a £1.65m NEC adjudication award in Premier Modular v Maidstone and Tunbridge Wells NHS Trust.
  - "the whole dispute turned on which programme was the Accepted Programme, and the date the claim relied on was never in it."
  - **Verify against the judgment.** Source **[vendor/consultancy]**: [necplanningsolutions – Premier Modular](https://www.necplanningsolutions.co.uk/post/nec-accepted-programme-premier-modular)
- **"Accepted with qualifications" (practitioner thread, 2011, pre-window but the same pain persists):**
  - A planner reports that a clause 32 programme "has been accepted but he says accepted with a load of qualifications", when the PM "should have just rejected it stating his reasons".
  - Another planner warns that unresolved comments leave "hostages to fortune when the inevitable disputes arise".
  - The planners then ask which programme to assess PM instructions (PMIs) against.
  - Source: [Planning Planet / projectcontrols.com "Accepted Programme"](https://projectcontrols.com/forums/planning-scheduling-programming-discussion/511147/accepted-programme)
- **Planning Planet library commentary on NEC3:** the "not practicable" and "not realistic" grounds are "highly subjective", which lets PMs reject on loosely defined grounds. — [Planning Planet search snippet: "The Programme Under NEC3: The Unacceptable Truth"](https://planningplanet.com/guild/library/programme-under-nec3-unacceptable-truth) (the page now returns 410 Gone)
- **Contractor remedies suggested:**
  - address earlier rejection reasons promptly
  - keep submitting updated programmes
  - escalate under Option W2
  - seek an adjudicator's declaration that a programme should be accepted.
  - Source: [Coniston Associates](https://coniston-associates.co.uk/mission-impossible-a-brief-guide-to-nec-programmes/)

### Inferences
- **The highest-value help is a pre-submission checker.** It would cover:
  - every clause 31.2 item, with float and time risk allowances shown separately, plus key dates, the work of others, and method and resources
  - the Scope requirements on format and milestones
  - basic logic integrity: open ends, unsupported constraints, a broken critical path
  - a generated change narrative against the last accepted programme.
- **A rejection-reason register** would cover the tactical gap that every source points to. It would link each PM reason to the fix and to resubmission and deemed-acceptance dates under clause 31.3.
- **Which programme is accepted, and when, is a records problem with legal weight** (Premier Modular, the dividing date under clause 63.1). Version provenance for "Accepted Programme" status is a real need.

### Gaps
- No statistics anywhere on NEC programme acceptance or rejection rates or the mix of rejection reasons. The NEC Users' Group was not reached.
- No 2020+ first-hand planner posts on rejections were retrieved.

---

## Q3. How do site teams feed progress back, and what do planners complain about in that loop?

### Takeaway
Progress usually flows from site as marked-up look-aheads, Excel sheets, verbal walk-rounds, photos and WhatsApp messages. The planner then re-keys it into the scheduling software. The recurring complaints:
- subjective, optimistic or disputed % complete
- disagreements over sign-off
- irregular updates, especially in the last months of a project
- contractor and consultant measuring progress differently
- site changing the sequence informally without telling the planner.

The result is as-built records that cannot support delay analysis.

### Cited Findings
- **Records gaps (HKA, Haris Katostaras, Oct 2020):**
  - "it is often difficult to accumulate detailed as-built records that will assist in the preparation of a reliable as-built programme"
  - "it is not unusual for the contractor to measure the actual progress of the works differently from the engineer/consultant", which "causes confusion, extra effort and subsequently extra cost"
  - progress updates "are not completed regularly"
  - "This discontinuity of records is commonly observed in the last months of projects."
  - Source: [HKA – Project records from a delay analysis perspective](https://www.hka.com/article/project-records-from-a-delay-analysis-perspective/)
- **Planning Planet "What is the best way to capture progress?"** (2009 onward; replies mostly pre-2020):
  - Methods described: two-week look-aheads exported to Excel "showing columns for start date, finish date, % complete"; Excel "job card" quantity sheets; "physically go see the work with your own 2 eyes" (reply about 6 years old).
  - Complaints: "problems in getting it signed off when we had disagreement on the task completion"; site staff "find always some strange excuses to say that, i am under evaluating 'their' progress"; PMs "dont want to be clear cut because they can fuge with the progress figures"; "% complete can be subjective"; "Manhours burnt is for me a measure of efficiency and not progress."
  - Source: [projectcontrols.com forum thread 419405](https://projectcontrols.com/forums/planning-scheduling-programming-discussion/419405/what-best-way-capture-progress)
- **Site sequence changes often bypass the planner.** When site changes the sequence, the planner often absorbs it and shifts the sequence instead of re-working the logic, and "the site manager handles the change informally". The planner's version then drifts out of date. — **[UK blog; vendor-adjacent]** via search snippet, [constructionai.io](https://www.constructionai.io/blog/construction-programmes-practical-guide) / [forgecommand.co.uk](https://forgecommand.co.uk/blog/construction-programme-management)
- **WhatsApp sites:** "If the schedule lives in the planner's desktop while the site team works from WhatsApp, you've wasted your investment." Photos shared on WhatsApp "get buried". — **[vendor]** [buildersai.co.uk](https://buildersai.co.uk/blog/construction-planning-software-uk); [brcks.io](https://www.brcks.io/blog/whatsapp-construction-software-for-uk-builders-2026-guide/)
- **Weak site-to-programme link.** Progress reporting is a main pain point "caused by a weak link between what happens on site and what appears on the programme". — **[vendor]** [LetsBuild WhatsApp guide](https://www.letsbuild.com/whatsapp-for-construction-guide)
- **Academic UK evidence:**
  - UK record-keeping practice is less rigorous than US practice, partly because UK contracts often do not require it. — [Construction Management and Economics, Vol 24 No 10](https://doi.org/10.1080/01446190500521207) (2006, pre-window)
  - A survey of UK practitioners found "lack of adequate contemporaneous records is the key reason that hinders early delay claims assessment". — [Buildings 3(3):598](https://doi.org/10.3390/buildings3030598) (2013, pre-window)
- **A known P6 artefact (tool-specific, but planners raise it):** a WBS summary shows 0% complete despite progress because schedule % complete is driven by planned value and budget at completion (BAC). — [Planning Planet thread](https://planningplanet.com/forums/planning-scheduling-programming-discussion/413255/progress-total-project)

### Inferences
- **The core unmet need is structured, low-friction capture of progress from site.** That means actual start and finish dates, remaining duration, and quantities instead of a subjective % complete, captured with timestamped evidence (photos) and reconciled automatically into the programme. It should also flag disagreement for sign-off. This also builds the as-built record that delay analysis later needs.
- **Late-project record decay** (HKA) suggests capture has to be nearly effortless for site staff, because discipline drops just when disputes crystallise.

### Gaps
- No 2020+ UK survey quantifies how site progress is gathered (paper, Excel, apps) or how long re-keying takes.
- No direct quotes from site managers on why they resist updating.

---

## Q4. What do clients, PMs and commercial teams want from the programme that they don't get today?

### Takeaway
Each group wants something different:
- **Clients and PMs** want a compliant, logically sound programme they can review quickly against DCMA- or CIOB-style checks, with a clear narrative of what changed since the last accepted version.
- **Commercial and claims teams** want an unbroken chain of accepted programmes and as-built records that can support time impact analysis (TIA) or windows analysis.
- **Site teams and non-planners** want a short, current look-ahead derived from the master programme, not a Gantt chart nobody reads.

In practice the master programme often serves contract compliance more than management, and short-term plans sit apart from it.

### Cited Findings
- **Schedule quality and review.** The CIOB Planning Protocol 2021 (PP21) includes software checks:
  - a link-logic test: tasks need incoming and outgoing links
  - a duration test capping tasks at 44 working days, because overly long tasks are hard to monitor.
  - Source: [Construction Management – CIOB Planning Protocol](https://constructionmanagement.co.uk/ciob-planning-protocol-using-software-to-mitigate-programme-risk/)
- **Review checklists** benchmark open ends below 5% (DCMA metric 1). They note that open ends on critical activities are a common finding, and that most links should be finish-to-start. — **[vendor/consultancy]** [schedulelens – How to review a contractor's programme](https://schedulelens.com/blog/how-to-review-contractor-programme/)
- **XER review tools** check for open ends, hard constraints, negative float, out-of-sequence progress and invalid dates. Their existence signals demand, but they are product claims. — **[vendor]** [xertoolkit.com](https://xertoolkit.com/); [schedulelens schedule analysis tools](https://schedulelens.com/blog/schedule-analysis-software/)
- **Compliance versus management (commentary on the CIOB Guide to Dynamic Time Modelling):**
  - Baseline programmes often serve contract compliance rather than project management.
  - Monthly updates frequently do not meaningfully revise the underlying model.
  - Detailed short-term plans sit apart from the master schedule.
  - Source (snippet only; full page 403): [The Contracts Group, Medium](https://medium.com/@thecontractsgroup/in-the-recent-past-a-number-of-technical-publications-have-attempted-to-bring-structure-and-785c85ef9d6e)
- **Communicating to site:**
  - Sites "run off the next two weeks" of the programme.
  - "A hand-drawn three-week look-ahead that is updated every Monday and briefed to the team is infinitely more useful than a beautifully detailed Primavera programme that is three months out of date."
  - "A programme produced at tender stage and never updated is a historic document, not a management tool."
  - The weekly look-ahead should be "cut from the programme rather than drawn beside it".
  - Sources **[UK blogs, mostly vendor-adjacent]**: [constructionai.io](https://www.constructionai.io/blog/construction-programmes-practical-guide); [forgecommand.co.uk](https://forgecommand.co.uk/blog/construction-programme-management); [necplanningsolutions – programme of works](https://www.necplanningsolutions.co.uk/post/programme-of-works)
- **Version control and "which programme is current":**
  - Teams mix up the JCT "master programme", the NEC4 "Accepted Programme" and the FIDIC "Programme".
  - Tender, baseline, working, look-ahead and as-built programmes each change at different rates.
  - A Level 3 programme "cannot show a different sequence or different milestone dates without a corresponding change to the master programme".
  - Source **[consultancy]**: [necplanningsolutions – programme of works](https://www.necplanningsolutions.co.uk/post/programme-of-works)
  - Practitioners dispute which programme delays should be measured against: the updated programme ("delays are normally measured using the Updated Construction programme, NOT the Baseline") or the baseline. — [Planning Planet "Revised Programme – Clause 14.2"](https://planningplanet.com/forums/forensic-claims-analysis/416481/revised-programme-clause-142)
  - The NEC4 dividing date (clause 63.1) fixes which Accepted Programme applies to a compensation event. — [Mondaq NEC Accepted Programmes guide](https://www.mondaq.com/uk/construction-planning/1219200/nec-accepted-programmes-a-practical-guide)
- **Delay analysis and claims support:**
  - In *Walter Lilly v Mackay* (2012), both experts accepted that the lack of a contemporaneous critical-path programme was an underlying problem. Where the programme record is thin, "no choice of method rescues the analysis". — **[consultancy]** via search snippet, [schedulelens – prospective vs retrospective](https://schedulelens.com/blog/prospective-vs-retrospective-delay-analysis/)
  - A UK forensic study found that where records were withheld, delay analysis was "theoretical", relying on assumptions, and experts disagreed on the baseline itself. — [ARCOM conference paper](https://www.arcom.ac.uk/-docs/proceedings/c53e4fee934df27582826028fc94751f.pdf) (date not confirmed)
  - The as-built programme is sometimes compiled at completion from fragments. — **[vendor]** [calim.ai](https://www.calim.ai/insights/contemporaneous-records-the-evidence-that-decides-construction-claims/)
  - HKA CRUX (9th edition, 2,410 projects, 122 countries) found schedule overruns averaging 112% of planned duration. The leading causes were change in scope and design issues, not planning per se. — [Infrastructure Now summary](https://www.infrastructure-now.co.uk/article/498373/hka-releases-9th-edition-of-crux-insight-report)
- **Resource and labour planning:** NEC clause 31.2 expects resources and method statements per operation. In practice these are almost never supplied, because subcontractors are not yet procured. — [Coniston Associates](https://coniston-associates.co.uk/mission-impossible-a-brief-guide-to-nec-programmes/)

### Inferences
- **PMs and clients want fast, consistent quality review plus a clear "what changed" view.** That means a diff between submissions in logic, dates, float and time risk allowances, with an explanatory narrative. Today this is assembled by hand.
- **Commercial teams want the programme history to be evidence:**
  - a versioned chain of submitted and accepted programmes
  - contemporaneous progress with timestamps
  - CE and TIA fragnets linked to the Accepted Programme at the dividing date.
- **Site teams want a derived, always-current, simple view.** That means a two-to-six-week look-ahead and one-page summaries generated from the master programme, not maintained separately.
- **Resource loading is a contractual expectation that is rarely met.** It is a possible white space, but direct demand evidence is weak.

### Gaps
- No client or PM-side survey of what they want from contractor programmes. APM and the IPA were not reached.
- No UK data on how often client XER reviews fail, or on which DCMA checks fail most often.
- No direct evidence on labour or resource planning pains beyond Coniston.

---

## Q5. What do planners think of AI-generated or AI-assisted programmes (trust, liability, quality)?

### Takeaway
The best UK-weighted evidence (RICS 2025) shows interest in AI for scheduling but very low adoption. Lack of skills, difficulty integrating with existing systems and poor data quality are the main barriers, and a large minority worry about the effect on their own role. Liability commentary puts responsibility on the professional who adopts an unchecked AI programme. Vendor messaging (nPlan) concedes that AI makes a "starting point", not a finished programme. No first-hand UK planner opinions on AI were retrieved.

### Cited Findings
- **RICS *AI in Construction 2025*** (more than 2,200 responses; 48% UK):
  - Adoption:
    - About 45% have no AI implementation.
    - 34% are in early pilots.
    - Just under 12% use AI regularly in specific processes.
    - 1.5% use it across multiple processes.
    - Under 1% have it fully embedded.
  - Progress monitoring and project scheduling were rated high-significance by 36%.
  - Barriers:
    - lack of skilled personnel, 46%
    - integration with existing systems, 37%
    - data quality and availability, 30%
    - cost, 29%
    - unclear return on investment, 28%
    - lack of standards and guidance, 25%
    - privacy and security, 22%
    - resistance to change, 20%
    - regulatory or legal uncertainty, 11%
  - From the RICS skills survey: "Forty-four percent of the PMs and 38% of the QS and construction professionals" are concerned about AI's impact on their own role. 48% of PMs feel overwhelmed by the pace of technological change.
  - Source: [RICS AI in Construction 2025](https://www.rics.org/news-insights/artificial-intelligence-in-construction-report)
- **Liability (non-UK, Canada):** a project-controls professional who adopts an AI schedule without checking it has arguably fallen below the standard of care. — [Mondaq Canada – AI-Generated Construction Schedules: Who Is Liable](https://www.mondaq.com/canada/professional-negligence/1811386/ai-generated-construction-schedules-who-is-liable-when-the-algorithm-is-wrong)
- **Liability (UK):** a UK piece notes that software providers carry no legal liability for inaccurate or hallucinated AI outputs, which leaves the practitioner exposed. — [Witan Solicitors](https://witansolicitors.co.uk/ai-construction-law/) (snippet-level)
- **Governance:** a named person should take responsibility before AI output carries decision weight. Reliance can create liability even when an output is marked "for discussion only". — [The Revenue Wire](https://www.therevenuewire.com/news/ai-outpaces-construction-governance-risk-ihab-osman)
- **Vendor framing (nPlan, UK-founded):**
  - "AI accelerates the production of a starting point, it doesn't replace the expertise that makes it good."
  - The nPlan CEO argues planners are biased: "you are eternally optimistic".
  - At a conference nPlan conceded that "for things that are much more complex, you want people to think about it".
  - Sources **[vendor]**: [nPlan blog](https://www.nplan.io/blog-posts/how-ai-driven-schedule-generation-will-change-what-construction-planning-means); [ENR](https://www.enr.com/articles/55472-nplan-promises-better-risk-management-through-ai-for-11b-uk-rail-project); [nPlan AACE 2025](https://webinars.nplan.io/nplan-at-aace-international)
- **Sceptical commentary:** nPlan's claim to have saved customers over $1.2bn has no published method for independent review. AI scheduling tools "don't care" that underlying schedules are poor ("88% ... garbage" framing, from an unverified statistic). — [AI Home Building](https://aihomebuilding.com/articles/ai-scheduling-garbage-data)
- **A user review:** "difficult to assess and accept the product in one go". — [G2 nPlan reviews](https://www.g2.com/products/nplan/reviews)
- **A generic AI limitation** (vendor): ChatGPT can draft a first-pass work breakdown structure but cannot maintain a live schedule with dependencies, resources or progress. — [ProjectManager.com](https://www.projectmanager.com/blog/chatgpt-project-management)

### Inferences
- **The acceptable AI role today is assistive and checkable**, for example:
  - drafting a first-cut logic network or fragnet
  - running quality and NEC-compliance checks
  - writing narratives and change summaries
  - flagging risk.
- **The output must be traceable** and remain clearly the planner's responsibility. Liability sits with the person who submits.
- **AI-generated programmes that a planner cannot audit will struggle**, given the NEC "realistic and practicable" tests and the expert-witness scrutiny in delay disputes.
- **Data quality and integration are top barriers** (RICS). That favours tools that work on existing XER, PP and MPP files rather than replacing the scheduler.

### Gaps
- No first-hand 2020+ UK planner statements (forum, LinkedIn, Reddit) on trusting AI-generated programmes were found. Reddit was blocked, LinkedIn was not indexed, and no projectcontrols.com AI thread surfaced.
- No UK survey isolates planners (as opposed to PMs and QSs) on AI attitudes.
- No evidence on how NEC PMs or clients would treat a programme declared as AI-assisted.
