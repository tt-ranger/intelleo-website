---
title: Batch or streaming? Start with the deadline
description: Use freshness targets, workload sizing, and recovery drills to
  decide whether to retain batch, tune it, or stream a few critical outputs.
answer: "Keep batch when it reliably delivers correct results before consumers
  need them. Size the compute separately: a big batch may need a cluster, while
  a small stream may not. Pilot streaming where even a tuned batch would miss a
  decision deadline."
author: Intelleo Editorial
automated: true
format: explainer
eventId: bc8d6e33cc51cad5a1bf9ce221b22499
cluster: data
subject: pipeline-architecture
publishDate: 2026-11-24T11:02:46.072Z
tags:
  - streaming
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
    publisher: huggingface.co
    date: 2026-11-18T15:00:23.000Z
hero:
  src: /images/editorial/batch-or-streaming-start-with-the-deadline-bc8d6e33.webp
  alt: Set a deadline and correctness target, test tuned batch at peak and during
    recovery, and pilot streaming if batch fails.
  credit: Diagram by Intelleo Editorial, based on the sources cited below.
---

A pipeline review should start with two questions: **When does the consumer need the result, and how much work does it take to produce it?** The first determines whether a schedule is good enough. The second determines how much compute to provision. A large overnight transformation may need distributed compute without needing streaming. A modest feed of machine readings may need continuous processing because an operator can still intervene. Changing the processing cadence won’t fix an oversized engine, and changing the engine won’t necessarily remove the wait for the next run.

## How fresh does the output need to be?

Start with the decision the output supports. For a report reviewed each morning, specify when it must be ready and which records it must include. For a signal that might influence a payment decision, specify when the application must receive the signal and what it should do if the signal is missing. In both cases, define an acceptable rate of missed deadlines. An average latency target alone won’t tell you whether the pipeline works when consumers need it most.

Measure from the source event or change to the point where the result is usable. For batch, include the wait for the next run, the transformation, and publication. For streaming, include ingestion, time in queues, any wait for an aggregation window, and delivery. If the result triggers an action, measure that handoff too. A faster query won’t help if the destination refreshes on a slower schedule or the application can’t act on the result.

**Hypothetical example:** A retailer uses sales events for both morning reconciliation and intraday replenishment. Test whether more frequent incremental batches deliver replenishment signals before the last useful ordering time, including on a busy day. If they do, keep the simpler path. If they don’t, test streaming for replenishment rather than moving reconciliation and its historical joins onto the same path. Give each output its own freshness and correctness targets.

## What does Flock’s migration tell us about batch scale?

[Data Engineering Weekly’s account of Flock](https://www.dataengineeringweekly.com/p/data-engineering-weekly-297) describes a move from AWS Glue to in-process DuckDB for its dbt transformations. The newsletter reports shorter core builds and lower daily compute spend. The supplied coverage doesn’t independently confirm the magnitude of those gains, so use the case to identify an option worth testing, not to estimate savings. It’s an account of changing the engine for batch work, not a comparison with streaming. Faster builds also don’t establish how long data waited for a run or when consumers could use it.

The newsletter frames the migration around Iceberg storage and the ability to change the compute engine without changing the storage architecture. [Leanpub’s survey of data engineering books](https://leanpub.com/topics/data-engineering) gives a separate, smaller-scale illustration: a teaching project loads DuckDB, transforms with dbt, and runs under Airflow on a laptop. Together, the examples show where an embedded engine fits in a batch workflow. The teaching project does not validate Flock’s results or establish production capacity.

For your own sizing decision, don’t use model count as a proxy for workload. Look at the largest scans and joins, peak memory, overlapping runs, and the amount of data you may have to reprocess. Compare time spent starting workers and coordinating work with time spent doing the transformations. Test a simpler engine on both a routine run and a backfill that overlaps scheduled work. If the candidate is cheaper on a quiet day but repeatedly misses the publication deadline during recovery, it hasn’t passed the same test as the incumbent.

## When is streaming worth testing?

[IBM’s write-up on time-series models in Confluent](https://huggingface.co/blog/ibm-research/time-series-powered-streamhouse) describes applying forecasting and anomaly detection to streaming data with Apache Flink and SQL. IBM suggests uses such as helping keep production lines in spec, detecting unusual store activity, and supplying signals for card-payment assessment. These are IBM’s proposed applications, not independently verified outcomes or comparisons against scheduled jobs. Their common premise is that a result arriving after a production run or payment authorization may no longer influence the decision.

That is a different question from the one Flock’s case raises. Flock’s migration is a reason to test whether your batch engine fits the workload. IBM’s examples are a reason to test whether waiting for a batch sacrifices a useful action. For a forecasting pilot, compare the same model and output under the two cadences if possible. Track when the forecast becomes usable, whether it arrives before the decision, and what happens when inference or delivery falls behind. That comparison isolates the value of earlier delivery from the value of adding the model in the first place.

Also test how the system behaves when information is incomplete. If a late event changes an alert, decide whether to revise the result, ignore it after a cutoff, or route it for reconciliation. If replay produces the same alert again, verify that the receiver won’t act twice. Don’t leave those choices to the streaming engine’s defaults: they depend on whether the output is advisory, feeds a report, or triggers an action that’s hard to reverse.

## What should go on the architecture review checklist?

Compare three candidates where practical: the current batch pipeline, a tuned or more frequent incremental batch, and the smallest streaming path that could meet the requirement. Use the same representative inputs and correctness checks. An apparent performance win means little if one candidate silently drops late records or publishes an output with different semantics.

- **Latency and freshness.** Specify the latest useful delivery time for each output. Measure end-to-end lag at normal load, at peak, and after an interruption. Count deadline misses and time to catch up; the first successful output after a restart doesn’t tell you when the backlog is clear.
- **Compute overhead.** For batch, separate startup and coordination from scans and transformations. For streaming, include baseline processing, buffering, retained state, checkpointing, and inference if applicable. Compare spend over the same period, including quiet hours and reprocessing. Put the cost beside the freshness results rather than choosing on compute spend alone.
- **Operational complexity.** Name the owners of lag alerts, schema changes, recovery, and downstream corrections. Exercise a failed batch run and a stream restart with replay. Ask operators to show how they would identify missing or duplicate outputs, recover them, and keep normal traffic running. Include the downstream team if recovery can reissue an action.

Agree on the decision rule before the pilot: eliminate candidates that miss freshness or correctness targets, then compare the survivors on cost, recovery burden, and migration effort. If a tuned batch passes, a continuously emitting source isn’t by itself a reason to stream. If no option passes, pinpoint the measured bottleneck before making the architecture larger. A slow destination, for instance, may limit both designs.

## Where should a hybrid design split the work?

Split by output rather than by source. A streaming path could publish provisional alerts while a batch path reconciles historical totals. Assign an authoritative output to each consumer, document how corrections are published, and test whether the two paths interpret the same business rules consistently. If neither team owns discrepancies, a narrow streaming pilot can leave you maintaining two definitions of the same result.

The default is to retain batch where it meets the deadline, right-size the engine where compute is a poor fit, and pilot streaming only for decisions that can’t wait. For related reading, browse the [data topic hub](/topics/data). If a pipeline feeds an AI application, see [how to evaluate an AI agent beyond its score](/blog/how-to-evaluate-an-ai-agent-beyond-its-score-a2cbe4b5) and [how AI search engines choose citations](/blog/how-ai-search-engines-choose-citations) for examples of looking beyond the pipeline to the output consumers actually use.
