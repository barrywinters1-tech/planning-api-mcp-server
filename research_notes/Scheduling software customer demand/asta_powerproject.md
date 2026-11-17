# Asta Powerproject (Eleco / Elecosoft): customer complaints, requests and recent releases

Method note: Capterra (.com/.co.uk/.co.nz), G2, Software Advice and GetApp review pages all returned HTTP 403 to direct fetch, and TrustRadius returned 404. So the review evidence below comes from search-engine snippets of those pages, which give paraphrased or short verbatim fragments, not full review text. The forum evidence comes from Planning Planet, which now redirects to projectcontrols.com. Reddit searches found no Asta-specific threads. The frequency signal ("N sources") counts independent pages or reviewers I could see, not total mentions in the market. Treat every count as a lower bound from a thin sample.

## 1. What do Asta users repeatedly complain about?

### Takeaway
The public review base is small (Capterra about 34 reviews at 4.5/5; G2 about 17 at 4.2/5) and mostly positive. The complaints that do recur are: (a) occasional crashes and glitches, worse on large files; (b) a learning curve and complexity on large, heavily linked sequences; (c) cost and licensing friction (licence transfer between machines, dongles and licence servers, paid API access); (d) programmes that are hard for non-Asta people to read; (e) P6/MSP interoperability rough edges (calendars on XER conversion, MSP XML export, a broken XER save-as in 2020); (f) a smaller ecosystem and job market than P6. I found no strong public evidence on printing/PDF complaints.

### Cited Findings
**Ratings and sample size**
- Capterra: 34 verified reviews, overall 4.5/5; customer service 4.6, ease of use 4.3. — [Capterra](https://www.capterra.com/p/173782/Powerproject/reviews/)
- G2: about 17 reviews at 4.2/5. G2 shows "Not enough data" for top pros and cons, and the "product direction" score of 6.4 comes from only 13 reviews (a weak signal on roadmap satisfaction). — [G2](https://www.g2.com/products/asta-powerproject/reviews)
- SelectHub aggregate: 62 reviews from "2 recognized software review sites", with 90% of users saying they would recommend it. Undated. — [SelectHub](https://www.selecthub.com/p/construction-management-software/powerproject/)
- Capterra marks some reviews as incentivised (reviewers are offered a nominal incentive). — [Capterra](https://www.capterra.com/p/173782/Powerproject/reviews/)

**Stability and crashes (about 3–4 independent sources)**
- GetApp reviewer: "Sometimes suffers from a glitch and crashes." — [GetApp CA](https://www.getapp.ca/software/2082798/powerproject)
- Capterra reviewer: the tool is prone to crash occasionally, making it less stable than some competing programs. — [Capterra](https://www.capterra.com/p/173782/Powerproject/reviews/)
- Capterra reviewer: glitches grow with file size; "bar titles changing, rows do not line up with text or the software freezes." This is the clearest large-programme performance complaint I found. — [Capterra](https://www.capterra.com/p/173782/Powerproject/reviews/) (via search snippet; also on [Capterra page 2](https://www.capterra.com/p/173782/Powerproject/reviews/?page=2))
- SelectHub's summary: "Some users report occasional crashes and glitches." — [SelectHub](https://www.selecthub.com/p/construction-management-software/powerproject/)
- Elecosoft's own 2026.2 release (Feb 2026) leads with "stability, speed, and usability improvements, plus bug fixes" (vendor framing, but it shows stability is a priority). — [Eleco 2026.2](https://eleco.com/smarter-collaboration-faster-planning-real-results/)

**Learning curve and complexity on large or highly linked programmes (about 3 sources)**
- G2 reviewers: the tool gets complex when building large sequences and linking them logically. — [G2](https://www.g2.com/products/asta-powerproject/reviews)
- SelectHub: the most common gripe is a "steep learning curve, especially for users unfamiliar with similar project management tools", and the extensive functionality "can overwhelm newcomers". — [SelectHub](https://www.selecthub.com/p/construction-management-software/powerproject/)
- Capterra reviewers coming from P6 report "a bit of transitionary learning". — [Capterra](https://www.capterra.com/p/173782/Powerproject/reviews/)
- Counter-signal: many reviewers call it easy to learn. A G2 reviewer says schedules "can be set up quickly", and a vendor-sponsored Saunders Construction piece says drag-and-drop makes it "much easier to use than P6". — [G2](https://www.g2.com/products/asta-powerproject/reviews); [Planning Planet newsletter (vendor-sponsored)](https://planningplanet.com/newsletter/544577)

**Hard for non-users to read the programme (1–2 sources)**
- Capterra UK reviewer (Ellis, construction, 22 Oct 2024, 4.0/5): con was that the programme is "difficult to follow" when shown to someone unfamiliar with the software. — [Capterra UK](https://www.capterra.co.uk/reviews/173782/powerproject)
- G2 and other reviewers also mention that it is hard to explain to people unfamiliar with it. — [G2](https://www.g2.com/products/asta-powerproject/reviews)

**Cost and licensing (about 4 sources)**
- Capterra reviewer wanted to use the software on different machines "without having to transfer licence". A later reviewer said the complex licensing structure had been resolved in v17 (from search snippet summaries). — [Capterra](https://www.capterra.com/p/173782/Powerproject/reviews/)
- SelectHub con: cost is "a potential barrier for smaller businesses or those with limited budgets". — [SelectHub](https://www.selecthub.com/p/construction-management-software/powerproject/)
- Third-party price estimate (unverified): single-user subscription about $1,200/yr, concurrent licence about $2,000/yr, plus implementation costs for SMBs. — [ITQlick](https://www.itqlick.com/powerproject)
- API access for integrations (Asta Vision REST API) needs an additional licence. — [The Digital Project Manager](https://thedigitalprojectmanager.com/tools/asta-powerproject-review/). In March 2026 Asta Vision Plus (the API product) launched as a "premium add-on" to existing Asta Vision customers. — [Construction Dive press release, 19 Mar 2026](https://constructiondive.com/press-release/20260319-elecosoft-launches-asta-vision-plus-to-turn-schedule-data-into-trusted-syst-1/)
- Dongle and licence-server overhead is documented by the vendor rather than complained about in reviews I could see. Dongle drivers must be on all networked devices, the Sentinel LDK service must keep running, IP forwarding is needed across subnets, and VM licence loans are capped at 30 days. — [Elecosoft licence server help](https://help.elecosoft.com/licence_manager/dutch/14.0.03/Content/Popup_topics/Licence_servers.htm); [Elecosoft cloud concurrent licensing FAQ](https://elecosoft.com/us/cloud-concurrent-licensing)
- Asta 2026.3 (autumn 2026) "moves Asta Powerproject to a new licensing platform." — [PBC Today, Asta 2026.3](https://www.pbctoday.co.uk/news/?p=166904) (search snippet; page returned 403)

**Interoperability with P6 and MS Project (about 3–4 sources, mostly forum, some older)**
- Planning Planet user moving from Asta to P6: XER conversion "works okay except for the calendars". — [Planning Planet thread "Primavera P6 and Powerproject"](https://planningplanet.com/forums/planning-scheduling-programming-discussion/561014/primavera-p6-and-powerproject)
- Planning Planet post: Asta's "Save As" XER export stopped working in late May 2020 (older). — [Planning Planet](https://planningplanet.com/comment/65992) (via search snippet)
- Asta forum thread "XML Export to MSP Problem" (6 replies, last reply Jan 2021; older). — [projectcontrols.com Asta forum](https://projectcontrols.com/category/forums/asta-powerproject?page=1)
- SelectHub: limited market presence outside the UK means "possible compatibility issues with international partners." — [SelectHub](https://www.selecthub.com/p/construction-management-software/powerproject/)
- Shipped answer: Asta 2026.3 adds "native Primavera P6 interoperability add-ins". — [PBC Today](https://www.pbctoday.co.uk/news/?p=166904)

**Functional gaps compared with P6 (1–2 sources)**
- G2 reviewer: "you cannot pause and restart activities like in primavera" (suspend/resume). — [G2](https://www.g2.com/products/asta-powerproject/reviews)
- G2 reviewer: help resources are harder to find online than for P6. — [G2](https://www.g2.com/products/asta-powerproject/reviews)
- Planning Planet: another user thought P6 has "a lot more small details" than Powerproject. — [Planning Planet comment](https://planningplanet.com/comment/38607)

**Forum topic signal (Planning Planet / projectcontrols.com Asta forum, 403 pages of threads; page 1 is mostly 2020–2025)**
- Recent threads include "Critical path drag" (40 replies, to Mar 2022: the most active, showing demand for advanced CPM analytics), "Float and dates don't make sense", "Slip disappears in new progress period" (2021), "New Task ID's when entering progress" (2022), "Near Critical Filter", "Collapse completed summary tasks only", "Currency format", "Early & Late 'banana curve'" (2021), "Project Comparison / Forensics?", "Reports on logic", "Resource Modelling" (Dec 2025). These read as progress-update quirks plus requests for analytics such as near-critical, drag, S-curves and comparison. — [projectcontrols.com Asta forum p1](https://projectcontrols.com/category/forums/asta-powerproject?page=1)

### Inferences
- The ranking by frequency in my visible sample: stability/crashes (most mentions) > learning curve and complexity at scale > cost and licensing > P6/MSP interoperability > readability for outsiders > specific P6 parity gaps (suspend/resume, drag, near-critical). Every count is small (1–4 sources each), so none of these is overwhelming.
- The licensing complaints (transferring between machines, dongles, licence servers) seem to have pushed Eleco toward cloud concurrent licensing, a v17 fix, and a new licensing platform in 2026.3. That points to persistent friction.
- The forum threads suggest progress-period handling (slip, new IDs, float) and analytical reporting are where power users struggle, more than basic Gantt editing.

### Gaps
- I could not read full review texts on Capterra, G2, Software Advice or GetApp (403). The quotes above are snippet-level. I found no TrustRadius page.
- I found no public evidence (2021+) of complaints specifically about printing/PDF output, despite Asta's reputation for good print output. This needs direct review access.
- I found no Reddit threads or attributable LinkedIn posts about Asta in this pass.
- I found no Asta user-group or "ideas portal" vote data.

## 2. What features do users ask for that are missing or weak? What did Elecosoft ship in v16/v17/2026.x, and which were framed as customer requests?

### Takeaway
Versions moved from v16 to v17 and then to calendar naming (2026, July 2025; 2026.2, Feb 2026; 2026.3, autumn 2026). Eleco's shipping pattern points to demand for: real-time multi-user collaboration without an Enterprise server (Asta Vision Live), dashboards/BI and portfolio KPIs (native Vision dashboards in 2026.3), P6 interoperability (native add-ins in 2026.3), API and integration access (Vision Plus, Mar 2026), better site progress and evidence capture (Siteprogress Field Evidence / Part L), filtering and coding productivity, baseline and revision governance, and "AI-ready" analytics (roadmap only). Eleco frames releases as "user-requested" in general terms but never ties specific features to specific requests.

### Cited Findings
**Version 17 (around 2023–2024)**
- Project timeline control panel (key-task overviews); task weighting / checklists (split a task into activities that are progressed and weighted individually); autosave on by default every 10 min; a new installer that pushes updates to subscribers; a real-time collaboration module and global template library listed as "coming soon" on some pages. — [Elecosoft news: Asta Powerproject update](https://elecosoft.com/news/asta-powerproject-update/); [Construction Management](https://constructionmanagement.co.uk/elecosoft-launches-updated-asta-powerproject/); [BIMplus](https://bimplus.co.uk/elecosoft-launches-updated-asta-powerproject)
- 17.2.8 release note: real-time collaboration via **Asta Vision Live**, described as "a much simpler solution with no need to set up and maintain an Asta Enterprise server". A user starts a collaboration session and others join, with the number of simultaneous programmes capped. Only for customers who bought Vision Live. No other features. — [Powerproject 17.2.8 release notes](https://help.elecosoft.com/powerproject_release_notes/english/Content/HTML%20Topics/17_2_8.htm)
- Earlier (Powerproject XV/15): Site Progress Mobile gained photo edit/annotate and adding new tasks remotely. — [Elecosoft news](https://elecosoft.com/us/?p=27985) (via search snippet)

**Asta Powerproject 2026 (available to subscribers July 2025)**
- Filters can be stacked (stacked filters for large code libraries); Excel/Word integration with Library Explorer for bulk-editing code libraries; timeline items colour-coded by code library; display tasks grouped by resource; live search of spreadsheet fields; smoother pan/scroll; clearer milestones; file compatibility back to v17; updates to project revision management, Site Progress mobile, and federated identity (SSO) support. — [Construction Dive press release, 29 Jul 2025](https://www.constructiondive.com/press-release/20250729-elecosoft-introduces-asta-powerproject-2026-1); [ForConstructionPros](https://www.forconstructionpros.com/construction-technology/project-management/product/22947316/elecosoft-elecosoft-releases-asta-powerproject-2026-with-workflow-and-usability-upgrades)
- Framing: the release offers "user-requested features and functionality updates", and Mark Chapman (Head of Innovation) said "We continue to listen closely to our customers." No feature is attributed to a specific request. — [Construction Dive](https://www.constructiondive.com/press-release/20250729-elecosoft-introduces-asta-powerproject-2026-1)

**Asta Powerproject 2026.2 (from 10 Feb 2026)**
- Stability, speed and usability improvements plus bug fixes; Asta 4D gets a streamlined ribbon and can create a plan directly from an IFC file; new **Asta Siteprogress Field Evidence** (Part L module) with geo-tagged photos and digital records for compliance and inspection readiness. — [Eleco "Built with you, for you"](https://eleco.com/smarter-collaboration-faster-planning-real-results/)
- Framing: "We've taken your feedback and turned it into powerful, practical updates." — [Eleco](https://eleco.com/smarter-collaboration-faster-planning-real-results/)

**Asta Vision Plus (19 Mar 2026)**
- Premium add-on: Asta Vision API v1 gives structured access to projects, tasks, workflows and calendars, with governance (standard codes and calendars, locking, version control), field progress flowing in via the API, and portfolio KPIs and risk indicators. The roadmap names "AI-powered predictive dashboards using historical schedule data and API feeds"; the product is positioned as "AI-ready". The pain points it names ("Lag between site and project", "Evidence and audit challenges") are vendor framing, not cited customer requests. — [Construction Dive press release](https://constructiondive.com/press-release/20260319-elecosoft-launches-asta-vision-plus-to-turn-schedule-data-into-trusted-syst-1/)

**Asta 2026.3 (autumn 2026, UK and Ireland)**
- New native dashboard / BI framework in Asta Vision; native Primavera P6 interoperability add-ins; intelligent baseline and revision management; better access to historical programme data (to inform tenders); planning governance controls; move to a new licensing platform. — [PBC Today](https://www.pbctoday.co.uk/news/?p=166904) (search snippet); [Eleco 2026.3 page](https://eleco.com/?p=41627)
- Customer testimonials on that page are about governance and visibility, not specific feature requests. Steven Tideswell (VINCI): "Asta Vision has also helped us to standardise our workflows by controlling our planning governance." Derek O'Neil (Careys Civil Engineering): Vision "enables us to view live project data across all our projects with greater transparency and consistency." — [Eleco 2026.3](https://eleco.com/?p=41627)

**User-voiced requests (independent of vendor)**
- Use on multiple machines without licence transfers (Capterra). — [Capterra](https://www.capterra.com/p/173782/Powerproject/reviews/)
- Suspend/resume activities like P6 (G2). — [G2](https://www.g2.com/products/asta-powerproject/reviews)
- Advanced CPM analytics: critical path drag (40-reply thread), near-critical filter, banana/S-curves, programme comparison and forensics, logic reports (forum threads 2019–2022). — [projectcontrols.com Asta forum](https://projectcontrols.com/category/forums/asta-powerproject?page=1)

### Inferences
- What Eleco shipped maps well to the likely demand. Collaboration without Enterprise server overhead, P6 interop, dashboards and portfolio views, and site evidence capture each match a pain point above or a known P6/cloud competitive gap. But nearly all the "requested" claims are vendor claims, and no public feature-vote data backs them.
- The shift of value into Asta Vision (cloud) add-ons (Vision Live, Vision Plus, dashboards) means collaboration, API and BI capabilities sit behind extra paid tiers. Given the cost complaints, that is a likely future pain point.
- Browser-native editing of the programme is still absent. Asta Powerproject remains a Windows desktop client, with Vision as the cloud hub. I found no release offering full in-browser scheduling.
- AI is roadmap only (Vision Plus "AI-ready"). I found no shipped AI scheduling feature through autumn 2026.

### Gaps
- I could not confirm whether a "v18" exists. Naming went from v17 to "2026" (July 2025). The exact v16 contents (around 2022) were not retrieved in this pass.
- I found no public evidence on Asta Risk (Monte Carlo) user complaints or requests.
- I found no independent user commentary on Siteprogress or Site Progress mobile quality or adoption.

## 3. How do UK planners compare Asta with P6 and MS Project when choosing?

### Takeaway
Asta is the incumbent among UK building contractors because it is cheaper and easier for discrete construction programmes. P6 dominates where clients mandate it (rail, highways, petrochemical, infrastructure), and that mandate (not features) drives tool choice and planners' job prospects. Under NEC4, the programme format is whatever the Scope or Z-clauses state, so client specification of P6 (or occasionally Asta or MSP) is what forces the choice.

### Cited Findings
- 2009 thread (older, but the sector split it describes persists): a planner reviewing 20–30 UK roles found only 1–2 asking for Asta, with "all Clients require P5/P6". Mike Testro said Powerproject is common among UK building contractors but rail and petrochem lean P5/P6. David Bordoli cited his own survey (Powerproject 65%, Primavera 17% of respondents) and called Primavera "a pig to use" for discrete projects, at 4x Asta's cost. Andrew Pearce: "in most cases Primavera is overcomplicated and too expensive for most construction planning." — [Planning Planet "Asta Users - Lack of opportunities"](https://projectcontrols.com/comment/45780)
- Planning Planet commenter: most planners lack authority to choose tools, and P6 is used because of contract requirements. — [Planning Planet thread](https://planningplanet.com/forums/planning-scheduling-programming-discussion/561014/primavera-p6-and-powerproject) (via search snippet)
- NEC4 clause 31.2: a programme is submitted "in the form stated in the Scope", so the software or file format is a contract choice. A Turner & Townsend presentation raised whether an MS Project file is acceptable when P6 was asked for. The CECA NEC4 Bulletin No. 57 (Sept 2025) mentions P6 and MS Project as typical tools and warns that Z-clauses can change submission rules. — [CECA NEC4 Bulletin 57 (Sept 2025)](https://gmhplanning.co.uk/wp-content/uploads/2025/09/CECA-NEC4-Bulletin-No.57-Project-Controls-alongside-an-NEC-contract-programme-September-2025-1.pdf); [Scribd NEC4 slides](https://www.scribd.com/document/438661376/NEC4-slides)
- Asta publishes NEC guidance (programme must show start date, completion date, and so on), which positions it for NEC programme submissions. — [Elecosoft help: Using Asta Powerproject with NEC contracts](https://help.elecosoft.com/powerproject/english/help/Content/HTML_Topics/Conceptual/Structuring_your_project/NEC/NEC.htm)
- Oracle ships a dedicated NEC4 module for Primavera Unifier/P6, a competitive pressure on Asta in NEC infrastructure work. — [Oracle NEC4 data sheet](https://oracle.com/nz/a/ocom/docs/nec4-data-sheet-uk-english.pdf)
- Vendor and partner comparison material (marketing): Elecosoft webinars with Paul Harris comparing Powerproject with MS Project and P6, and "switching from P6" webinars. — [Eleco webinar: Paul Harris compares Powerproject vs P6](https://eleco.com/webinar-archive/paul-harris-compares-powerproject-vs-oracle-primavera-p6); [Elecosoft](https://elecosoft.com/us/?p=26822). A partner blog claims P6 per-user licensing is expensive for large teams. — [Petroglyph Projects (reseller)](https://www.petroglyphprojects.com/blog/why-loyal-p6-users-are-switching-to-powerproject-construction-project-management-software-2/)
- Reviewers who chose Asta over P6 cite drag-and-drop ease and fast schedule setup. Reviewers who miss P6 cite suspend/resume, finer detail, and more online help resources. — [G2](https://www.g2.com/products/asta-powerproject/reviews); [Planning Planet](https://planningplanet.com/comment/38607)

### Inferences
- The decisive factor in UK selection is the client or contract mandate, not features. Asta's strategic weak point is mandated-P6 infrastructure work, which explains Eleco's 2026.3 investment in native P6 interop add-ins, letting contractors plan in Asta and submit XER.
- MS Project shows up mainly as the "cheap or default" alternative and as an export target (MSP XML issues). I found little evidence of UK construction planners choosing MSP over Asta for main-contractor programmes.

### Gaps
- I found no recent (2021+) quantitative UK market-share survey of planning tools. The 65%/17% figure is a 2009 self-reported forum survey.
- I found no trade-press (Construction News, Building) articles from 2021+ on Asta vs P6 selection or tender mandates. The PBC Today and Construction Management coverage is release PR.
- I could not identify specific public clients (for example National Highways, Network Rail) with published Asta or P6 mandates in this pass. It is widely understood that these clients mandate P6, but I did not confirm it with a source here.
