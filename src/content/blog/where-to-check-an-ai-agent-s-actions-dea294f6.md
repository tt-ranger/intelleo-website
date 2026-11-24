---
title: Where to check an AI agent’s actions
description: Review the exact payment before dispatch, then enforce permissions
  and transaction rules at the service that moves the money.
answer: Check the exact payment proposal before dispatch to see whether it
  matches the user’s request. At commit, have the payment service independently
  enforce permissions and transaction rules. A secure tool connection verifies
  the route and caller, not the purpose of the payment.
author: Intelleo Editorial
automated: true
format: explainer
eventId: dea294f6e8b9a35efd0a3d26c9f7bd30
cluster: software-for-ai
subject: agent-architectures
shape: how-it-works
publishDate: 2026-11-24T11:31:04.662Z
tags: []
sources:
  - url: https://developers.googleblog.com/did-the-user-ask-for-this-securing-ai-agents-against-intent-hijacking-with-semantic-governance-policies/
    title: Did the user ask for this? Securing AI agents against intent hijacking
      with Semantic governance policies- Google Developers Blog
    publisher: Google for Developers
    date: 2026-11-23T00:00:00.000Z
  - url: https://developers.googleblog.com/check-what-your-ai-agents-do-before-they-do-it-with-semantic-governance-policies/
    title: Check what your AI agents do before they do it, with Semantic governance
      policies- Google Developers Blog
    publisher: Google for Developers
    date: 2026-11-20T00:00:00.000Z
  - url: https://developers.googleblog.com/how-to-securely-connect-internal-cloud-run-mcp-servers-to-gemini-enterprise/
    title: How to securely connect internal Cloud Run MCP servers to Gemini
      Enterprise- Google Developers Blog
    publisher: Google for Developers
    date: 2026-11-20T00:00:00.000Z
  - url: https://casrai.org/news/gao-report-ai-cybersecurity-cyberattacks-defense-2026
    title: "GAO Report: AI Cyberattacks and Cyber Defense — CASRAI"
    publisher: CASRAI
    date: 2026-11-21T00:00:00.000Z
hero:
  src: /images/editorial/where-to-check-an-ai-agent-s-actions-dea294f6.webp
  alt: "Abstract illustration: A faceted token fits through a matching outline,
    travels down a sealed channel, and meets a separate mechanical gate."
  credit: Illustration generated with AI (recraft/recraft-v4.1-flash) for Intelleo
    Editorial.
---

A user asks a banking agent to pay a December bill. The agent opens the invoice and proposes a transfer. The payment tool is genuine, and the caller has valid credentials. But the proposed recipient came from an instruction embedded in the invoice, not from the user’s request. If you were reviewing this system, where would you expect the payment to stop?

[Google’s account of a bill-payment task from AgentDojo](https://developers.googleblog.com/did-the-user-ask-for-this-securing-ai-agents-against-intent-hijacking-with-semantic-governance-policies/) illustrates the distinction between reading an invoice for payment details and treating it as a source of instructions. It is a vendor account of a benchmark example, not independent evidence that a particular guardrail will protect a production payment system. The architecture below is a design recommendation, not a claim about a product’s effectiveness.

## What should you check before dispatch?

Review the proposed tool call, not the agent’s description of its plan. “Pay the December bill” names a task but doesn’t tell a reviewer what will happen. The proposal should identify the action, source account, destination, amount, currency, and invoice reference. Compare those fields with the user’s request and the records your system relies on to interpret it. The user need not dictate every field: asking to pay a known invoice can be enough to establish intent when trusted records resolve the details.

In a hypothetical accounts-payable workflow, the invoice supplies the amount due and a vendor reference. The vendor record supplies the approved destination. If the invoice lists a different bank account, hold the proposal and route the discrepancy through the verified payee-change process. The question is not whether the prose on the invoice looks suspicious. It is whether the destination in the proposed call is supported by the request and the records that govern it.

Put that decision outside the model that proposed the action, at a point where denial prevents dispatch. In [Google’s description of Semantic governance policies](https://developers.googleblog.com/check-what-your-ai-agents-do-before-they-do-it-with-semantic-governance-policies/), Agent Gateway forwards a model-proposed call to a policy engine. Google says a rejected proposal is replaced with a denial message before it reaches the agent. If you use a model to help judge intent, give it a way to return “unclear” and hold the proposal. Don’t make a semantic verdict the final authority over the transfer.


![Four steps: propose a specific payment, review intent, dispatch over an authenticated route, and enforce rules at commit.](/images/editorial/where-to-check-an-ai-agent-s-actions-dea294f6-figure-1.webp)

*Figure 1: Review the specific payment before it leaves the agent, then enforce transaction rules where the money moves.*


## Why does the payment service still need to say yes?

Intent and permission can disagree in both directions. In one hypothetical case, a user clearly requests a transfer but lacks authority to debit the selected account. In another, the agent’s credentials permit transfers, but the user requested only a balance check. The first case calls for service-side denial; the second calls for a stop before dispatch. Neither decision substitutes for the other.

At the service that commits the transfer, check the authenticated identity against current permissions and evaluate the transaction against authoritative records. For example, is the destination approved? Does the amount require a second approver? Has this invoice already been paid? The agent can collect information or start an approval workflow, but the service should verify the approval record rather than accept the agent’s assertion that approval exists. Evaluate rules that depend on changing state as part of committing the transaction, so an earlier review doesn’t override a revoked permission or miss a payment posted while the proposal was pending.

Bind the intent decision and any required approval to the payment fields they covered. If the recipient is supplied as an alias, resolve it before review or verify that the destination used at commit is the one reviewed. If the amount or destination changes, send the revised transaction back for review. Keep retry handling separate: after a timeout, look up or retry the same operation under the same identifier. A timeout leaves the outcome uncertain; it is not a reason to create a new payment.

## What does a secure tool connection actually verify?

[Google’s guide to connecting internal Cloud Run MCP servers](https://developers.googleblog.com/how-to-securely-connect-internal-cloud-run-mcp-servers-to-gemini-enterprise/) describes private routing and two identity checks: Cloud Run IAM verifies the service caller, and the MCP application validates the signed-in user’s OAuth token. Those are properties of the connection and the identities on it. The checks described do not compare the payment destination with the invoice the user meant to pay.

When reviewing an architecture diagram, ask what each component sees and what it can stop. A gateway that sees the conversation and proposed call can evaluate intent. A tool endpoint can authenticate its caller. The payment service has the records and state it needs to decide whether to commit. Even if several checks run in one component, identify each decision separately. Inventory every path that can reach the payment service, including human approval and retry paths, and apply the same transaction rules whichever route the request takes.


![A table compares the placement and decision question for intent, connection security, and payment rules.](/images/editorial/where-to-check-an-ai-agent-s-actions-dea294f6-figure-2.webp)

*Figure 2: A valid identity does not establish intent, and a clear request does not grant permission to move money.*


## How can you tell which check failed?

Use a non-settling environment and start with a payment that should pass all three checks. Then change one decision input at a time. In a hypothetical test suite, keep the identities and transaction permissions valid but make the proposed payment unrelated to the user’s request. Expect a pre-dispatch denial. Next, keep the request unambiguous but remove the user’s debit permission. Expect the payment service to reject it. Finally, test an invalid caller identity with a proposal that would otherwise pass. Expect rejection at the connection boundary.

Test the handoff as well as the individual checks. Change a reviewed payment field and verify that the changed proposal cannot commit under the earlier decision. Retry a processed operation and verify that the service reports the previous outcome without recording another transfer. For each negative case, assert both where the request stopped and what the payment service recorded. A refusal in the chat tells you what the agent said, not whether the service moved money.

Use a shared operation identifier to trace the user request, reviewed proposal, dispatch decision, and service outcome. Keep references to the relevant policy and approval records without putting full bank details or raw invoice contents in general-purpose logs. If a denied proposal reached the service, inspect dispatch routing. If a reviewed proposal was rejected at commit, inspect the current authorization and transaction state. If the committed payment differs from the one reviewed, inspect how the proposal was resolved or transformed after approval. Also investigate unnecessary holds: a vendor alias that resolves to an already approved record calls for better identity resolution, not a blanket exception for destination changes.

## Which boundary should you fix first?

If the payment service cannot reject an unauthorized transaction on its own, fix that before granting the agent payment access. Then add a pre-dispatch check of the exact proposal and verify that the reviewed fields survive the handoff. If intent remains unclear, ask a specific question about the disputed field. If the check is unavailable, hold the proposal. Tell the user whether it was never dispatched or whether an earlier attempt is still being reconciled; those statuses call for different next steps.

A practical release criterion is that each negative test has a verifiable service outcome, not just the expected language from the assistant. For more on designing those tests and deciding which work can wait, see [how to evaluate an AI agent beyond its score](/blog/how-to-evaluate-an-ai-agent-beyond-its-score-a2cbe4b5) and [batch or streaming: start with the deadline](/blog/batch-or-streaming-start-with-the-deadline-bc8d6e33) in the [Software for AI topic hub](/topics/software-for-ai).
