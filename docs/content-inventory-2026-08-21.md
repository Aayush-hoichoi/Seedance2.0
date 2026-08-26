# All-time generated content inventory

**Snapshot:** 2026-08-21T07:30:00Z (fixed cutoff — every figure below is taken
at the same instant, so totals reconcile).
**Coverage:** 2026-06-12 → 2026-08-21 · **71 calendar days** · platform lifetime.
**Method:** read-only queries against the production Neon database. Measured
figures are marked plainly; estimated figures carry their method and range.

---

## 0. The central fact: this platform has two eras

The database does not hold one continuous history. It holds two, with different
instrumentation, and any number quoted without saying which era it covers is
wrong.

| | **Era A — Pre-gateway** | **Era B — Gateway** |
| --- | --- | --- |
| Window | 2026-06-12 06:04 → 2026-07-11 07:20 | 2026-07-11 07:39 → present |
| Duration | 30 days (22 active) | 41 days |
| System of record | `seedance_prompts` only | `jobs` + `billing_events` + `audit_log` |
| Records per generation | 1 (the prompt) | 3–5 (job, reservation, settlement, event, prompt) |
| Knows the user | ✗ | ✓ |
| Knows the model | ✗ | ✓ |
| Knows the outcome | ✗ | ✓ |
| Knows the cost | ✗ | ✓ |
| Knows the project | ✗ (0 of 1,715 rows) | ✓ |
| Storage key recorded | ✗ | partially |
| Appears in gallery / dataset | ✗ | ✓ |

**Era A is 19% of all generations and is invisible to every product surface.**
It does not appear in the Community Gallery, the console dashboards, any budget
figure, or the training dataset. It exists only as 1,715 prompt rows.

---

## 1. All-time headline

| Metric | Value | Basis |
| --- | --- | --- |
| **Total generations attempted** | **≥ 9,082** | 7,367 measured + 1,715 measured-as-accepted |
| **Total successfully generated** | **≈ 7,705** | 6,033 measured + ~1,672 estimated |
| — videos | ≈ 6,424 | 4,752 measured + ~1,672 estimated |
| — images | 1,281 | measured |
| **Total spend** | **≈ $18,200 – $18,900** | $13,906.59 measured + $4,325–$4,998 estimated |
| Video runtime produced (Era B only) | 31,898 s = **8 h 51 m 38 s** | measured |
| Confirmed durable storage keys | **3,403** of ~7,705 outputs (44.2%) | measured |
| Distinct people who generated | ≥ 17 | Era A has no user attribution |
| Models used | 9 (5 video, 4 image) + 1 unattributed era | measured |

The `≥` on attempts is deliberate: Era A only recorded a generation **after the
provider accepted the task**, so anything rejected before task creation in that
month left no trace at all. True all-time attempts are higher by an unknowable
margin.

---

## 2. All-time volume by month

| Month | Era A | Era B | Total | Notes |
| --- | --- | --- | --- | --- |
| 2026-06 (from the 12th) | 1,143 | — | **1,143** | pilot period, 14 active days |
| 2026-07 | 572 | 5,302 | **5,874** | gateway launches on the 11th; volume 5× |
| 2026-08 (to the 21st) | — | 2,065 | **2,065** | lower volume, much higher quality |
| **All-time** | **1,715** | **7,367** | **9,082** | |

Run-rate: Era A ~78/active day; Era B ~180/day. The gateway launch coincides
with a **2.3× step change in throughput**, sustained for six weeks.

---

## 3. Era A — pre-gateway, in full

Everything recoverable about the first month, from 1,715 prompt rows.

### 3.1 What is measured

| Metric | Value |
| --- | --- |
| Accepted generation tasks | **1,715** |
| Window | 2026-06-12 06:04:09Z → 2026-07-11 07:20:13Z |
| Active days | 22 of 30 |
| Peak day | **343** (2026-06-27) |
| Mean per active day | 78 |
| Carrying reference media | 1,672 (97.5%) |
| Mean references per generation | 2.08 (max 6) |
| Passed through the prompt enhancer | 609 (35.5%) |
| Mean prompt length | 619 characters |
| Marked liked | 66 |
| Binned (soft-deleted) | 27 |
| Task-id format | `cgt-<14>-<5>`, 24 chars — uniform, so a single provider (ModelArk) throughout |

### 3.2 Reference composition (3,572 attached assets)

| Role | Count | Share |
| --- | --- | --- |
| `reference_image` | 2,120 | 59.3% |
| `reference_video` | 974 | 27.3% |
| `first_frame` | 396 | 11.1% |
| `last_frame` | 82 | 2.3% |

**940 generations (54.8%) attached a source video** — video-to-video was the
majority workload from day one, not something that emerged later.

### 3.3 Style / mode

| Style | Count | Share | Liked | Binned |
| --- | --- | --- | --- | --- |
| (none recorded) | 1,106 | 64.5% | 19 | 4 |
| Motion Capture | 582 | 33.9% | 45 | 23 |
| Green Screen | 15 | 0.9% | 2 | 0 |
| Performance Transfer | 12 | 0.7% | 0 | 0 |

Motion Capture is 33.9% of Era A against 10.8% of Era B, and the enhancer ran on
35.5% of Era A against 17.0% of Era B. **The house styles were used twice as
heavily in the pilot month as they are now** — worth understanding, because that
is the differentiated part of the product.

### 3.4 What cannot be recovered, ever

| Dimension | Status |
| --- | --- |
| Who generated it | **unrecoverable** — no user column |
| Which model | **unrecoverable** — no model column |
| Resolution / duration / ratio | **unrecoverable** |
| Succeeded or failed | **unrecoverable** |
| Cost | **unrecoverable** |
| Project / title attribution | **unrecoverable** — 0 of 1,715 rows carry `project_id` |
| Whether the output was archived | **unrecoverable from the DB** — needs a bucket listing |

### 3.5 Estimates, with method

**Outcome.** Era A rows were written immediately after `createTask` returned an
id (`SeedanceStudio.jsx:932`), so all 1,715 are *provider-accepted* tasks. The
right comparator in Era B is accepted video tasks only:

> Era B, video jobs with a `provider_task_id`: **4,959 accepted → 4,752 succeeded = 95.8%**
> Same, restricted to the first two weeks (2026-07-11 → 07-25): **2,674 → 2,607 = 97.5%**

Applying the adjacent-in-time 97.5%: **≈ 1,672 succeeded, ≈ 43 failed.**
Conservative floor at 95.8%: 1,643.

**Cost.** Mean and median settled cost per *accepted* video task in the early Era
B cohort (n = 2,674, failures included at ~$0):

| Basis | Rate | × 1,715 |
| --- | --- | --- |
| Mean | $2.9145 | **$4,998** |
| Median | $2.5221 | **$4,325** |

**Era A cost estimate: $4,300 – $5,000.** Assumption: the resolution and model
mix in June resembled mid-July. Only the Seedance 2.0 family existed then, and
the early cohort is dominated by it, so the assumption is reasonable — but it is
an assumption, and the true figure is not in this database. The authoritative
answer is the BytePlus billing console for June 2026.

---

## 4. Era B — gateway, measured

### 4.1 Outcomes

| Category | Attempted | Succeeded | Failed | Timed out | Running | Success rate |
| --- | --- | --- | --- | --- | --- | --- |
| Video | 5,855 | **4,752** | 1,092 | 10 | 1 | 81.2% |
| Image | 1,512 | **1,281** | 214 | 17 | 0 | 84.7% |
| **Total** | **7,367** | **6,033** | 1,306 | 27 | 1 | **81.9%** |

Two different success rates matter and are routinely conflated:

| Measure | Video | Meaning |
| --- | --- | --- |
| End-to-end | **81.2%** | of everything a user pressed Generate on |
| Post-acceptance | **95.8%** | of tasks the provider actually took |

The 14.6-point gap is **submit-time rejection** — bad parameters, expired
assets, quota, policy. That gap is the product's problem to close, and it is
entirely addressable in-app.

### 4.2 By model

| Category | Model | Attempted | Succeeded | Failed | Success rate | Spend | Share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Video | Seedance 2.0 | 5,291 | 4,416 | 865 | 83.5% | $13,267.78 | 95.4% |
| Video | Seedance 2.0 Fast | 224 | 114 | 110 | **50.9%** | $160.14 | 1.2% |
| Video | Seedance 2.0 Mini | 210 | 161 | 49 | 76.7% | $138.49 | 1.0% |
| Video | Seedance 2.5 | 110 | 44 | 65 | **40.0%** | $96.55 | 0.7% |
| Video | Seedance 1.5 Pro | 20 | 17 | 3 | 85.0% | $6.42 | 0.05% |
| Image | Nano Banana Pro | 1,202 | 980 | 205 | 81.5% | $224.66 | 1.6% |
| Image | Nano Banana 2 | 232 | 227 | 5 | **97.8%** | $8.81 | 0.06% |
| Image | Seedream 5.0 Pro | 50 | 48 | 2 | 96.0% | $1.44 | 0.01% |
| Image | Cinematic Studio | 28 | 26 | 2 | 92.9% | $6.03 | 0.04% |

### 4.3 Spend ledger

| Event type | Events | USD |
| --- | --- | --- |
| Reservation | 6,998 | $14,897.56 |
| **Settlement** | **6,032** | **$13,906.59** |
| Failure | 436 | $3.74 |
| Release | 886 | $0.00 |

Reserved-minus-settled = $990.97, released back correctly. The reservation
system is behaving.

Unit economics: **$2.88 per finished video, $0.19 per finished image.**
Cost distribution per video (n = 4,752): p25 $1.89 · median $2.64 · mean $2.88 ·
p75 $3.75.

### 4.4 How the work is made (video)

| Mode | Count | Share | | Tier | Count |
| --- | --- | --- | --- | --- | --- |
| Multi reference | 3,627 | 62.0% | | 1080p | 3,774 |
| Image → Video | 759 | 13.0% | | 720p | 449 |
| Motion Capture | 632 | 10.8% | | 4k | 157 |
| First + Last frame | 461 | 7.9% | | 480p | 14 |
| (unrecorded) | 359 | 6.1% | | (unset) | 354 |
| Text → Video | 11 | 0.2% | | | |
| Performance Transfer | 2 | 0.03% | | | |

Image tiers: 4K 961 · 2K 314 · 1K 1 · unset 5. Every image request used
`imageCount = 1` — the multi-image path has never been exercised.

Average successful clip: **7.3 s**. Text-to-video is 0.2% of volume: this is a
reference-driven tool, and should be designed as one.

### 4.5 By user (Era B only)

| # | User | Total | Videos | Images | Succeeded | Failed | Fail rate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | sayan.maiti@hoichoi.tv | 2,951 | 1,811 | 1,140 | 2,509 | 429 | 14.5% |
| 2 | anweshadebnath816@gmail.com | 899 | 783 | 116 | 584 | 311 | 34.6% |
| 3 | shinjini.nandy@hoichoi.tv | 853 | 821 | 32 | 671 | 181 | 21.2% |
| 4 | shreya.paul.logline@gmail.com | 710 | 705 | 5 | 524 | 183 | 25.8% |
| 5 | ashish.mallick@hoichoi.tv | 575 | 575 | 0 | 546 | 29 | 5.0% |
| 6 | ipshito.logline3@gmail.com | 262 | 144 | 118 | 232 | 29 | 11.1% |
| 7 | rjgoesonline@gmail.com | 207 | 207 | 0 | 206 | 1 | **0.5%** |
| 8 | nehakabir.logline@gmail.com | 205 | 205 | 0 | 191 | 13 | 6.3% |
| 9 | manabk35@gmail.com | 203 | 203 | 0 | 191 | 12 | 5.9% |
| 10 | arghyamukherjee.logline@gmail.com | 145 | 137 | 8 | 123 | 22 | 15.2% |
| 11 | sohamchatterjee.tube01@gmail.com | 131 | 125 | 6 | 58 | 73 | **55.7%** |
| 12 | navjot.conceptpr@gmail.com | 118 | 54 | 64 | 99 | 15 | 12.7% |
| 13 | saranideb331@gmail.com | 73 | 65 | 8 | 72 | 1 | 1.4% |
| 14–17 | 4 further accounts | 31 | 16 | 15 | 23 | 6 | — |

**17 of 29 registered accounts have ever generated.** One user is 40% of all
Era B volume. Failure rate spans 0.5% to 55.7% across users on the same models —
a 100× spread that is a skill and interface problem, not a model problem.

### 4.6 By project

| Project | Total | Videos | Images | | Project | Total | Videos | Images |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bytedance | 2,930 | 2,031 | 899 | | Animation Prahlad | 75 | 67 | 8 |
| **Default** | **1,100** | 1,093 | 7 | | Bumper Bangla | 55 | 26 | 29 |
| Dream Bris Vegas | 980 | 547 | 433 | | Social Media | 55 | 45 | 10 |
| Ram Krishna | 834 | 834 | 0 | | The Good Samaritan | 44 | 44 | 0 |
| Hooliganism | 484 | 466 | 18 | | MSP Steel | 13 | 13 | 0 |
| TURTLE | 322 | 228 | 94 | | Ajeya | 2 | 2 | 0 |
| Katukutu Buro Svf | 249 | 244 | 5 | | test2/3/4 + TESTING | 23 | 14 | 9 |
| Beparwaah | 197 | 197 | 0 | | | | | |

**Attribution gap: 1,100 Era B generations (15%) plus all 1,715 Era A
generations (100%) carry no production attribution — 2,815 of 9,082 all-time
(31%) cannot be charged back to a title.**

---

## 5. Storage position, all-time

Everything lives in one bucket: `seedance-studio-3000805842` on
`tos-ap-southeast-1.bytepluses.com`, under `videos/`, `images/`, `uploads/`.

| Cohort | Outputs | Durable key recorded | Coverage |
| --- | --- | --- | --- |
| Era B images | 1,281 | **1,274** | 99.5% |
| Era B videos | 4,752 | **2,129** | 44.8% |
| Era A videos | ~1,672 | **0** | 0% (no field exists) |
| **All-time** | **~7,705** | **3,403** | **44.2%** |

**Fewer than half of everything this platform has ever produced has a confirmed
durable storage key.**

Three separate reasons, needing three different responses:

1. **Era A (~1,672 videos)** — the schema had nowhere to record a key. Objects
   may exist under `videos/<taskId>.mp4` if the browser archived them at the
   time; the 1,715 task ids are known, so this is *verifiable by listing the
   bucket*.
2. **Era B, 2,623 videos** — the browser archive path writes the object but
   never writes the key back to the job row. Some proportion of these are fine
   and merely unrecorded. Also verifiable by listing.
3. **7 images (jobs 5844–5850, 2026-08-09/10)** — the TOS credential-rotation
   window. Their bytes sit as base64 inside `jobs.result` in Postgres; they
   render nowhere.

**This is the single highest-priority follow-up in this report.** I could not
resolve it here: the `ARK_AK` in the local `.env.local` is rejected by TOS with
`InvalidAccessKeyId` (revoked, or from another account). A bucket listing with
working credentials converts ~4,300 "unknown" outputs into either "safe" or
"permanently lost", and nothing else in this document is worth acting on before
that answer exists.

---

## 6. Engagement and dataset — with coverage caveats

### Engagement

| Signal | Events | Distinct items | Distinct users |
| --- | --- | --- | --- |
| Download | 521 | 337 | 13 |
| Like | 178 | 177 | 11 |
| Unlike | 6 | 6 | 4 |

**`generation_events` begins 2026-07-26 — it covers 26 of the platform's 71
days (37%).** Every engagement rate computed from it is therefore a lower bound.
Even taken at face value, only **337 outputs have ever been downloaded** against
~7,705 produced (4.4% all-time; 5.6% within Era B). Either the delivery path
runs outside the product, or the platform has no idea which of its outputs were
any good.

### Training dataset

| Metric | Value |
| --- | --- |
| `dataset_samples` rows | 5,629 (4,355 video · 1,274 image) |
| Output confirmed present | 3,220 (57.2%) |
| Era A pairs included | **0 of 1,715** |
| True potential corpus | **7,344 brief→output pairs** |

The dataset view joins through `gallery_generations`, which is built from
`jobs` — so all 1,715 Era A pairs are excluded by construction, **including 609
enhanced production briefs**, the highest-value prompt data the company owns.
Recovering them needs only a `task_id`-keyed backfill; the prompts and refs are
already stored.

---

## 7. Failure analysis (Era B, 1,306 failures)

| Cause | Count | Class |
| --- | --- | --- |
| Output audio flagged for copyright | 103 | policy |
| Model overloaded / high demand | 72 | transient |
| Provider account quota exceeded | 48 | capacity |
| Output audio flagged as sensitive | 48 | policy |
| Image blocked by safety filter | 48 | policy |
| Invalid `video_url` — asset expired (slots 1,2,3,5) | 64 | **self-inflicted** |
| Invalid `image_url` — asset expired | 43 | **self-inflicted** |
| Video total duration invalid | 39 | validation |
| Input text flagged as sensitive | 22 | policy |
| Image model timeout at 290 s | 17 | transient |
| Output video flagged for copyright | 10 | policy |

- **~231 (18%) are content-policy rejections**, overwhelmingly on the audio
  track of Bengali source video. Pre-flight detection would recover most.
- **≥ 107 are expired reference assets** — the 1-hour Asset Library sweep firing
  mid-session. Entirely self-inflicted and fixable by extending the window or
  re-registering at submit.
- Era A failures are estimated at ~43 and cannot be characterised.

Quality trajectory: July failure rate **19.6%** → August **12.8%**. The
provider-constraint fixes shipped this month are working and are worth
continuing.

---

## 8. Governance activity (Era B)

| Flow | Counts |
| --- | --- |
| Model-access requests | 71 total — 36 approved · 34 revoked · 1 pending |
| Budget-increase requests | 50 created · 28 approved · 22 denied (56% approval) |
| Billing events written | 14,351 |
| Audit-log entries | 780 |
| Projects created | 22 (18 active) |
| Registered users | 29 |
| Legacy `usage_events` rows | 358 — **verified as a subset of `jobs`, not a third era**; zero rows lack a matching job |

---

## 9. Data-quality ledger

What the system cannot currently answer, and what it would take to fix.

| Question | Answerable? | Blocker | Fix |
| --- | --- | --- | --- |
| How many videos exist in the bucket? | No | no bucket listing performed; local key revoked | list the bucket; reconcile against 6,467 known task ids |
| What did June cost? | No | Era A has no billing rows | BytePlus billing console (external) |
| Who made the first 1,715 generations? | **Never** | no user column existed | accept the loss |
| Which outputs are actually good? | Barely | engagement covers 37% of lifetime; 4.4% download rate | instrument delivery; add explicit rating |
| What can be charged to which title? | 69% | 2,815 generations unattributed | require a project on every submit; retire "Default" |
| Which prompts produce winners? | Partially | 1,715 pairs excluded from the dataset | backfill Era A into the dataset view |

---

## 10. Findings

1. **44.2% durable-storage coverage is the headline risk.** Roughly 4,300
   outputs, representing on the order of $12,000 of spend, have no confirmed
   object key. Resolve by bucket listing before anything else.
2. **A fifth of the platform's history is invisible to the platform.** Era A —
   1,715 generations, ~$4,700, 609 enhanced briefs, 582 Motion Capture runs — is
   absent from the gallery, the dashboards, and the dataset. The prompt data
   survives and can be backfilled.
3. **Concentration is extreme on every axis.** One model = 95.4% of spend, one
   user = 40% of volume, one project = 40% of output. Any of the three changing
   materially moves the whole business.
4. **The newer video tiers are failing.** Seedance 2.5 at 40% and 2.0 Fast at
   51% success, against 83.5% for the flagship. These are not usable defaults
   and should not be offered as if they were.
5. **14.6 points of the failure rate are pre-provider** — parameter and asset
   problems the app could catch before the user waits. ~340 failures a month.
6. **Success is a skill, not a setting.** 0.5% to 55.7% failure across users on
   identical models points at onboarding and interface affordances.
7. **31% of all output has no production attribution.** Chargeback to a title is
   impossible for nearly a third of spend.
8. **The corpus is real and unused.** 7,344 potential brief→output pairs, 3,220
   with confirmed outputs, sitting behind no product surface.
9. **Quality is improving fast.** 19.6% → 12.8% failure in one month is a strong
   signal that the constraint-encoding work is the right investment.
10. **Instrumentation itself is the recurring failure.** Three separate blind
    spots — no Era A schema, no key write-back on the browser archive path,
    engagement events starting 45 days late — each cost real answers. Treat
    "what will this let us measure?" as a launch requirement.
