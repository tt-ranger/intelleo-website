---
title: Batch or streaming? Start with the deadline
description: Choose a pipeline by when its output must be usable. Size compute
  separately, and pilot streaming only where a tuned batch would arrive too
  late.
answer: "Keep batch when it reliably delivers correct results before consumers
  need them. Size compute separately: a large batch may need a cluster, while a
  small stream may not. Pilot streaming where a tuned batch would still miss a
  decision deadline, and test whether faster output actually changes the
  decision."
author: Intelleo Editorial
automated: true
format: explainer
eventId: bc8d6e33cc51cad5a1bf9ce221b22499
cluster: data
subject: pipeline-architecture
shape: comparison
publishDate: 2026-11-24T11:02:46.072Z
tags: []
sources:
  - url: https://www.dataengineeringweekly.com/p/data-engineering-weekly-297
    title: "Data Engineering Weekly #297"
    publisher: Data Engineering Weekly
    date: 2026-11-23T03:27:26.000Z
  - url: https://leanpub.com/topics/data-engineering
    title: "Data Engineering books and courses: what they teach — Leanpub"
    publisher: Leanpub
    date: 2026-11-23T22:12:38.000Z
  - url: https://huggingface.co/blog/ibm-research/time-series-powered-streamhouse
    title: "Time-Series Models in the Streamhouse: A New Frontier and Use Cases"
    publisher: IBM Research
    date: 2026-11-18T15:00:23.000Z
hero:
  src: /images/editorial/batch-or-streaming-start-with-the-deadline-bc8d6e33.webp
  alt: "Abstract illustration: Two paths carry beads toward the same closing
    aperture: one releases them in groups, the other one by one. Differently
    sized channels separate carrying capacity from cadence."
  credit: Illustration generated with AI (recraft/recraft-v4.1-flash) for Intelleo
    Editorial.
---

A hypothetical retailer has two jobs for the same inventory feed. The planning team needs a reconciled snapshot before its morning purchasing run. The checkout service needs to know whether it can promise the last unit before confirming an order. Publishing every inventory change might help checkout, but it does nothing for the planners if their snapshot was already correct and on time. And if checkout needs an authoritative reservation, a faster feed alone won't give it one.

For engineers choosing between scheduled batch, shorter incremental batches and continuous processing, the first question isn't how fast the engine can run. It's when each consumer stops being able to use the result. Ask that question separately for each output, even when the outputs share a source. A model's online features and its training dataset don't have to update on the same clock.

## When does the result stop being useful?

Write down the consumer, the action it takes and the latest time it can take that action. Then define what counts as a usable result: how current the input must be, which records must be present and whether a provisional answer is acceptable. A report can have a fixed delivery deadline. An online feature can have a maximum age at inference time. An alert can have a deadline relative to the event that triggered it. Those are different contracts, even if every pipeline publishes to the same store.

Measure from the event or input cutoff to the point where the consumer can read a validated result. For batch, include upstream arrival, the wait for the next run, queue time, execution, checks and publication. For streaming, include ingestion lag, processing, any wait for late events and the time it takes for the serving layer to expose the update. A job finishing on time doesn't help if the consumer is still reading yesterday's partition or a stale cache.

[IBM Research's announcement about time-series models in Confluent](https://huggingface.co/blog/ibm-research/time-series-powered-streamhouse) makes the timing problem concrete: a forecast delivered after a payment authorization may be accurate but too late to affect it. IBM says its integration can apply forecasting and anomaly detection to streaming data through Flink. That's an implementation example, not evidence that streaming will meet your deadline. Use the consumer's timing contract to decide which options deserve a test.


![Scheduled batch, incremental batch and streaming compared by when they fit, what delays output and what to test.](/images/editorial/batch-or-streaming-start-with-the-deadline-bc8d6e33-figure-1.webp)

*Figure 1: Use the least demanding cadence that meets the consumer's deadline and correctness rules. Choose compute size after measuring the work.*


## Can a tuned batch meet the deadline?

Start by measuring the existing job under realistic load, including slow upstream deliveries, busy compute queues and runs that need a retry. Look at the fraction of outputs that arrive both correct and on time, not just the median runtime. For a fixed deadline, find out how much margin remains once the output is visible. For a recurring decision, check whether events arriving just after a cutoff wait too long for the next usable result.

Tune the part of the path that costs you the most time. If the job repeatedly scans unchanged data, try processing only new or changed partitions. If the schedule dominates, run smaller increments more often and check that startup overhead and overlapping runs don't erase the benefit. If late inputs dominate, faster compute won't make those inputs appear. A shorter batch interval is worth testing when it buys enough time without forcing consumers to accept incomplete data.

In a hypothetical example, a feature refresh takes three minutes but runs every 30 minutes. An event that just misses the input cutoff may wait nearly a full interval before the next run even starts. If the feature must reflect changes within ten minutes, shortening the interval could solve the problem. But five-minute increments that take three minutes leave about two minutes at the worst point in the schedule for queueing, validation and serving, before accounting for any upstream delay. Test that margin under load rather than treating it as guaranteed.

## How much compute does the work need?

Treat cadence and capacity as separate decisions. Estimate how much data each run reads, how expensive its joins or model calls are, and what memory and throughput it needs at peak. For a stream, include retained state, bursts and catch-up after downtime. A batch that joins large historical datasets may need distributed compute to finish before publication. A low-volume stream with a simple transform and bounded state may fit on one worker, although recovery and availability requirements still matter.

[Data Engineering Weekly](https://www.dataengineeringweekly.com/p/data-engineering-weekly-297) reports that Flock moved nearly 480 dbt models from AWS Glue to in-process DuckDB. The same issue describes Meesho routing Spark jobs onto warm cluster pools. Read those as contrasting examples of compute placement, not as a head-to-head benchmark or a batch-versus-streaming result. The [Leanpub data engineering guide](https://leanpub.com/topics/data-engineering) offers a smaller example: a teaching pipeline that loads DuckDB, transforms with dbt and runs under Airflow on a laptop. Neither the tool name nor the fact that a job is scheduled tells you what infrastructure it needs.

Compare candidate deployments at the same correctness and deadline target. For batch, count startup, idle capacity and retries as well as execution. For streaming, count continuously provisioned capacity, state storage and the resources needed to recover while fresh events keep arriving. The useful cost comparison is what each design costs to meet the same consumer contract, not what an isolated job or worker costs to run.

## What would a streaming pilot have to prove?

Pick one decision for which measured batch delay matters. Run the stream alongside the tuned batch and record when each result becomes usable. Compare them at the same input cutoff and under the same rules for late records. Otherwise, a provisional stream output can appear faster simply because it excludes data the batch waits for. If provisional results are useful, measure how often they change and what a correction would mean for the consumer. Updating a dashboard is different from retracting an action already taken.

Exercise duplicate events, out-of-order arrival, a restart and a backlog. Check whether processing a record again can repeat a side effect, whether replay reproduces the expected result and how long the system takes to return to its freshness target after an outage. For ML features, check that the streamed calculation and the offline reference use the same time boundaries and missing-value rules. If the pilot shows a difference in model behavior, determine whether it comes from fresher inputs or a change in feature semantics. For more on evaluating a system beyond a single metric, see [how to evaluate an AI agent beyond its score](/blog/how-to-evaluate-an-ai-agent-beyond-its-score-a2cbe4b5) and [where to check an AI agent's actions](/blog/where-to-check-an-ai-agent-s-actions-dea294f6).

Set the promotion rule before the pilot. Require the stream to meet the deadline at the agreed reliability level, stay within a defined tolerance against the reference result, and recover within the time the consumer can tolerate. Then ask whether the earlier result changes enough decisions to justify another production path. Lower processing latency is not, by itself, a reason to migrate.

## Which design should you keep?

Keep scheduled batch when it has enough margin to deliver a correct result through routine delays and retries. Use shorter incremental batches when waiting for the next run is the main problem and smaller runs still leave room for validation and recovery. Pilot streaming when a tuned batch cannot meet the deadline and the source emits the needed data early enough for a stream to help. If the source itself is late or the consumer cannot act any sooner, fix that constraint first.

A mixed design can be the right outcome: stream the signal that changes a live decision, and keep batch for historical rebuilds or reconciled outputs. If both paths calculate the same metric, say which is authoritative and how corrections reach consumers. Revisit cadence when the decision deadline changes; revisit compute when the workload changes. They need not change together. Explore more architecture guides in [Data](/topics/data).
