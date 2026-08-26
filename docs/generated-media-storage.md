# Where generated media is stored

Reference map of every generated image and video, by model. All output lands in
one BytePlus TOS bucket under two prefixes; Postgres holds only the key.

## Storage target

| Setting | Value |
| --- | --- |
| Bucket | `TOS_BUCKET` — currently `seedance-studio-3000805842` (code default `seedance-studio-assets`) |
| Endpoint | `tos-ap-southeast-1.bytepluses.com` |
| Host | `<bucket>.tos-ap-southeast-1.bytepluses.com` |
| Credentials | `ARK_AK` / `ARK_SK` (HMAC-SHA256, SigV4-style — `lib/byteplus/tosSign.js`) |
| Read access | Presigned GET, 7 days, minted locally by `presignKey()` — no object is public |

## Videos

Key format: `videos/<providerTaskId>.mp4` — the ModelArk task id with every
non-`[\w.-]` character replaced by `_` (`lib/seedance/archiveKey.mjs`).

| Model | Model ID | Provider | Stored at |
| --- | --- | --- | --- |
| Seedance 2.5 | `dreamina-seedance-2-5-260628` | BytePlus ModelArk | `videos/<taskId>.mp4` |
| Seedance 2.0 | `dreamina-seedance-2-0-260128` | BytePlus ModelArk | `videos/<taskId>.mp4` |
| Seedance 2.0 Fast | `dreamina-seedance-2-0-fast-260128` | BytePlus ModelArk | `videos/<taskId>.mp4` |
| Seedance 2.0 Mini | `dreamina-seedance-2-0-mini-260615` | BytePlus ModelArk | `videos/<taskId>.mp4` |
| Seedance 1.5 Pro | `seedance-1-5-pro-251215` | BytePlus ModelArk | `videos/<taskId>.mp4` |

All five models share one prefix and one naming rule — there is no per-model,
per-project or per-user folder.

Example:

```
https://seedance-studio-3000805842.tos-ap-southeast-1.bytepluses.com/videos/cgt-20260819-a1b2c3.mp4
```

Written by `settleSuccess()` in `lib/gateway/processor.mjs` (server-side, at
settle) and by `POST /api/byteplus/archive` (browser, if the tab is still open).
Both produce the same key, so a re-run overwrites rather than duplicates.

DB pointer: `jobs.result.video_key` → `gallery_generations.video_key` →
`dataset_samples.output_key`.

## Images

Key format: `images/job-<jobId>-<index>.<ext>` where `<jobId>` is `jobs.id`,
`<index>` is the position in the request (0-based), and `<ext>` derives from the
returned MIME type: `jpeg → jpg`, `webp → webp`, otherwise `png`
(`lib/gateway/storage.mjs`).

| Model | Model ID | Provider | Stored at |
| --- | --- | --- | --- |
| Nano Banana 2 | `nano-banana-2` | Google `generateContent` | `images/job-<jobId>-<i>.<ext>` |
| Nano Banana Pro | `nano-banana-pro` | Google `generateContent` | `images/job-<jobId>-<i>.<ext>` |
| Cinematic Studio | `cinematic-studio` | Google (Pro route) | `images/job-<jobId>-<i>.<ext>` |
| Seedream 5.0 Pro | `seedream-5.0-pro` | BytePlus `images/generations` | `images/job-<jobId>-<i>.<ext>` |

Every adapter requests base64 rather than a provider URL so the bytes can be
persisted to this bucket instead of an expiring provider link.

Example — a 3-image generation on job 4821:

```
images/job-4821-0.png
images/job-4821-1.png
images/job-4821-2.png
```

Written by `storeImages()` in `lib/gateway/storage.mjs`, called from
`settleSuccess()` before billing.

DB pointer: `jobs.result.images[]` (full array) →
`gallery_generations.image_key` (**first image only**) →
`dataset_samples.output_key`.

## Reference inputs (not outputs)

| Input | Stored where | Key |
| --- | --- | --- |
| Video-mode uploads | TOS | `uploads/<epoch>-<rand>-<name>` |
| Same file, registered for ModelArk | BytePlus Asset Library (group per project) | `asset://<id>` — swept after ~1h |
| Image-mode reference images | Postgres, not TOS | base64 in `jobs.request_body.parts`, downscaled to ~1024px JPEG |

## Exceptions — when media is not in the bucket

| Case | Actual location | Effect |
| --- | --- | --- |
| Video archive failed at settle | ModelArk signed URL only | dead after ~24h; `video_key` NULL |
| Legacy pre-gateway videos | never archived (`usage_events` era) | links long expired |
| `ARK_AK`/`ARK_SK` missing or rotated — video | nothing written | video lost |
| `ARK_AK`/`ARK_SK` missing or rotated — image | base64 inside `jobs.result` in Postgres | image unrenderable; table grows |
| Provider returned a URL with no base64 | provider URL stored verbatim | expires |
| Images 1..n of a multi-image job | in the bucket, but only image 0 is indexed | invisible in gallery / liked / dataset |
| `/studio` (MuAPI shell) output | MuAPI's CDN + browser `localStorage` | outside this bucket, DB and console entirely |

## Retention

No lifecycle rule is configured on the bucket. Objects under `videos/`,
`images/` and `uploads/` are kept indefinitely, including failed takes and
re-rolls.
