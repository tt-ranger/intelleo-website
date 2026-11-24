---
title: How to Evaluate an AI Agent Beyond Its Score
description: Test the agent you plan to deploy, check whether its graders catch
  plausible failures, and use the evidence to set permissions and oversight.
answer: Evaluate the configured agent on tasks that reflect the work it will
  actually do. Then test the graders against expert-labeled successes and
  plausible failures. Use both results to approve specific inputs, actions, and
  levels of human oversight—not to declare the agent reliable in general.
author: Intelleo Editorial
automated: true
format: analysis
eventId: a2cbe4b55e7f1209411208ae9c07e205
cluster: ml
subject: model-evaluation
shape: decision-guide
publishDate: 2026-11-24T11:02:46.072Z
tags: []
sources:
  - url: https://huggingface.co/blog/agentic-evals
    title: How to build and maintain an agentic evaluation
    publisher: Hugging Face
    date: 2026-11-23T00:00:00.776Z
  - url: https://openai.com/index/introducing-medchembench/
    title: Can AI help scientists identify promising drug candidates?
    publisher: OpenAI
    date: 2026-11-21T18:30:00.000Z
  - url: https://casrai.org/news/metr-th2-ai-time-horizons-research-judgment-evaluation-2026
    title: METR TH2 AI Time Horizons & Research Judgment — CASRAI
    publisher: CASRAI
    date: 2026-11-21T01:15:54.000Z
hero:
  src: /images/editorial/how-to-evaluate-an-ai-agent-beyond-its-score-a2cbe4b5.webp
  alt: "Abstract illustration: Two translucent sieves sit in series above separate
    channels. The first sorts shapes by fit; the second catches a near-match
    that slipped through."
  credit: Illustration generated with AI (recraft/recraft-v4.1-flash) for Intelleo
    Editorial.
---

Suppose a data team is deciding whether to let an agent send a weekly operations report without review. In a test run, the report looks right, but the agent includes a restricted field in the attachment. A grader that checks only the written summary would pass the run. The deployment decision depends on whether the evaluation can see that failure, not just on how often the agent writes a good report.

[Hugging Face’s guide to agentic evaluation](https://huggingface.co/blog/agentic-evals) frames the work around tasks, scoring, and checking that results support the claim being made. It also describes the shift from checking answers to checking actions: the software around the model can change the score. For teams building [ML systems](/topics/ml), that means making two separate judgments: did this configured agent do acceptable work, and would the evaluation notice if it didn’t?

## What exactly are you asking permission to deploy?

Write the proposed permission before choosing tasks or a passing score. In the hypothetical report workflow, start with a narrow claim: the agent may draft a weekly report from approved tables when the input matches a supported schema; a human must approve the report before it leaves the workspace. Sending it without review is a separate decision. So is letting the agent query a new table or modify a record. Each changes what can go wrong and what evidence you need.

Record the configuration that the claim covers: model version and settings, prompts, tools, data access, action permissions, retry policy, and approval steps. Run with those conditions or document the differences and limit the claim accordingly. A test with a simulated send can show whether the agent requests the right recipient and attachment. It cannot show that the production approval gate intercepts the request. Test that gate separately before relying on it. [Where to check an AI agent’s actions](/blog/where-to-check-an-ai-agent-s-actions-dea294f6) is a companion to deciding where those checks belong.

## Which tasks would make that permission defensible?

Sample from the work you expect the agent to receive, and keep routine traffic separate from deliberately difficult cases. Use common cases to estimate performance on the supported workflow. Add cases where foreseeable mistakes would change the release decision: missing data, a changed schema, conflicting instructions, a restricted field that resembles an approved one, or a tool timeout after an action was requested. Label these groups in the results. A suite packed with tricky cases helps test controls, but its overall pass rate should not be presented as an estimate of production performance.

For each task, specify the starting state, available tools, allowed actions, and acceptable end states. Include cases where asking for clarification or stopping is the right outcome. Where more than one result is acceptable, describe the invariant rather than requiring an exact match to one reference answer. In the report example, two summaries can differ in wording and still pass; neither may attach restricted data. Keep some tasks out of prompt and grader development so the release decision is not based entirely on examples the team has already tuned against.

## What should count as a pass?

Grade the output, the actions, and the resulting state separately. Use direct checks where you can: did totals match approved data, did the payload contain a restricted field, and did anything get sent? Use a rubric for judgments such as whether the report explains a material caveat. Inspect tool calls and their results rather than inferring actions from the agent’s final message. If you cannot observe a required action or state change, mark that check unresolved rather than passing it by default.

[OpenAI’s MedChemBench announcement](https://openai.com/index/introducing-medchembench/) illustrates the value of distinguishing evidence types: it describes separate criteria for molecular structures, scientific explanations, rankings, and property predictions. That is an example of benchmark design, not evidence for deploying the reporting agent. In your workflow, the practical question is which checks can compensate for others. Clear writing cannot make up for an unauthorized send. Define non-negotiable failures before running the evaluation, and report them separately from quality scores.


![A table distinguishes checking the report’s totals, inspecting the attachment request, and verifying that nothing was sent before approval.](/images/editorial/how-to-evaluate-an-ai-agent-beyond-its-score-a2cbe4b5-figure-1.webp)

*Figure 1: A correct summary is necessary but cannot establish that the agent used permitted data or left the workspace in the expected state.*


## Can the graders tell good work from plausible failures?

Build a separate grader validation set from expert-labeled examples. Include acceptable outputs that differ from the reference and failures realistic enough to fool a reviewer on a quick read. Start with real runs where available, then construct paired examples that change one important feature at a time. For the hypothetical report, keep the prose identical while changing the attachment from an approved field to a restricted look-alike. In another pair, replace an unnecessary guess with a justified request for clarification. These pairs reveal whether a grader responds to the difference that matters.

Have domain reviewers label the examples before seeing automated grades, then resolve disagreements or record genuine ambiguity. Compare grader decisions with the reviewed labels by failure type. Count false passes and false failures separately: a false pass on a prohibited action changes the release decision; false failures on valid drafts may instead overload reviewers. Inspect the disagreements before changing a threshold. The fix might be a clearer rubric, a direct state check, or human review for cases where the evidence is incomplete. Hold back examples for checking the revised grader rather than declaring success on the cases used to repair it.

## What do the results actually let you approve?

Report outcomes by input class and action, with counts and denominators. Keep agent performance separate from grader performance. Show how often the agent completes the task, escalates correctly, attempts a prohibited action, or leaves the outcome unverified. Repeat selected tasks when runs can vary, particularly near an approval boundary. Report repeated runs as such: ten attempts on one input do not cover ten distinct inputs. Zero observed critical failures in a small sample is not proof that the failure cannot occur.

[CASRAI’s independent coverage of METR’s evaluation](https://casrai.org/news/metr-th2-ai-time-horizons-research-judgment-evaluation-2026) describes separate task families for programmatically verifiable work and work requiring human or structured qualitative assessment. Its reporting is a reminder to look at what a score covers before transferring it to a different kind of work. The release decision here is local: if standard reports pass direct checks and the graders catch plausible draft errors, approve drafts for those inputs. If attachment checks or the approval gate remain unverified, do not grant send permission. For unfamiliar schemas, route to review or decline rather than silently extending the approved input range.


![Three decision rows approve reviewed drafts, withhold unverified sending, and route unsupported inputs to review or decline them.](/images/editorial/how-to-evaluate-an-ai-agent-beyond-its-score-a2cbe4b5-figure-2.webp)

*Figure 2: Make separate decisions about accepted inputs and allowed actions rather than assigning the entire agent one release status.*


## When should you revisit the decision?

Record the release decision with the configuration, supported inputs, permitted actions, oversight requirements, and evidence behind them. Decide who reviews escalations, what they can see, and when they must intervene. If review cannot happen before the workflow’s [deadline](/blog/batch-or-streaming-start-with-the-deadline-bc8d6e33), narrow the permission rather than treating nominal oversight as a working control. After release, audit a sample of apparent successes as well as escalations. Feed newly observed failure modes into the task suite and grader checks. Revisit the approval when the model, permissions, tools, traffic, or grader changes in a way that could affect the original claim.

**Rule of thumb:** Approve the narrowest combination of inputs, actions, and oversight that both the agent runs and the grader validation support. If you are comparing prototypes, a shared score can help you decide which one to investigate next without implying deployment approval. If an action is irreversible, hard to observe, or too costly to tolerate even once, a passing evaluation is not enough: require an enforced control or keep the action out of scope.
