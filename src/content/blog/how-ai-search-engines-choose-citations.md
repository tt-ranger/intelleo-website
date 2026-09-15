---
title: How Do AI Search Engines Decide What to Cite?
description: Generative engines pick sources by retrievability and verifiability, not by search ranking. Here is what that changes about how you publish.
answer: Generative engines select sources they can retrieve as self-contained passages and verify against a date, a number and an attributable publisher. Search ranking barely predicts citation, so the work is structural rather than promotional.
cluster: geo
subject: llm-citation-behavior
publishDate: 2026-09-15
author: Sandeep Katti
tags: [geo, retrieval, citations, llm]
originalData: false
sources:
  - url: https://www.enrichlabs.ai/blog/generative-engine-optimization-geo-complete-guide-2026
    title: "Generative Engine Optimization (GEO): The Complete 2026 Guide to Ranking in AI Search"
    publisher: Enrich Labs
    date: 2026-01-15
  - url: https://www.digitalapplied.com/blog/scaled-content-abuse-google-march-update-ai-pages-decimated
    title: "Scaled Content Abuse: Google's AI Page Crackdown Guide"
    publisher: Digital Applied
    date: 2026-03-25
  - url: https://llmpulse.ai/blog/llms-txt-guide/
    title: "llms.txt: The Complete 2026 Guide (Generator, Examples, Validators)"
    publisher: LLM Pulse
    date: 2026-02-10
faq:
  - question: Does ranking well on Google mean an AI engine will cite me?
    answer: Largely no. Analyses of citation behaviour find that most sources cited by ChatGPT, Gemini and Copilot do not appear in Google's top ten for the same query. The two systems select on different criteria, so they need to be treated as separate problems.
  - question: Is llms.txt worth implementing?
    answer: Not as a priority. Adoption is around ten percent of sites, but monitoring of AI crawler traffic shows the file is almost never requested, and Google has said it does not support the format. It costs ten minutes, so it is harmless, but it should not displace structured data or citation hygiene.
  - question: What single change most improves citation odds?
    answer: Attaching a date, a number and a named publisher to every factual claim. It makes a passage verifiable in isolation, which is the property a generative engine is selecting for.
---

Most teams approach AI search the way they approached Google in 2010: publish more, target more phrases, hope for the best. That instinct misreads what a generative engine actually does. It does not rank a list of pages for a human to choose from. It retrieves passages, assembles an answer, and attaches citations to the specific claims it used.

That difference changes what makes a page worth citing. This piece works through the mechanism, then the practical consequences.

## Why doesn't search ranking predict citation?

The most counterintuitive finding in this area is how weakly the two correlate. Reporting on citation behaviour in [the 2026 GEO guide from Enrich Labs](https://www.enrichlabs.ai/blog/generative-engine-optimization-geo-complete-guide-2026) notes that fewer than 10% of sources cited by ChatGPT, Gemini and Copilot rank in Google's organic top ten for the same query.

That gap makes sense once you look at the retrieval path. A search ranking is a judgement about which *page* best serves a query, informed heavily by authority signals accumulated over years — links, domain history, engagement. A citation is a judgement about which *passage* best supports a sentence the model is about to write. Those are different units of selection and different evidence.

A page can rank first and still be useless to a generative engine: if its answer is spread across eight paragraphs, hedged, and interleaved with navigation copy, there is no clean passage to lift. Conversely, an obscure page with one crisp, dated, attributable paragraph can be cited repeatedly.

## What is the engine actually selecting for?

Three properties, roughly in order of weight.

**Retrievability.** The passage must survive chunking. Retrieval systems split documents into segments and embed them independently, so a paragraph that depends on three earlier paragraphs for its meaning arrives at the ranking stage stripped of that context. Self-contained paragraphs win because they are still coherent after the split.

**Verifiability.** Models and the ranking layers around them favour claims carrying internal evidence: a number, a date, a named source. This is not a stylistic preference. A claim with those attributes can be checked against other retrieved documents; a bare assertion cannot.

**Entity clarity.** The engine needs to resolve who is speaking. Consistent organisation naming, author identity and structured data let it attach your claim to a known entity with a track record, rather than to an anonymous URL.

Research summarised in the same GEO guide found that citing sources, adding statistics and including quotations improved AI visibility by 30-40% in controlled comparisons, published in 2026 by [Enrich Labs](https://www.enrichlabs.ai/blog/generative-engine-optimization-geo-complete-guide-2026). Note what those three interventions have in common: each one makes a passage independently checkable.

## Does publishing more articles help?

Only if each one clears the bar above — and there is a real penalty for getting this wrong.

Google's scaled content abuse policy targets "generating many pages primarily to manipulate search rankings, with little or no value added for users," and it applies regardless of whether a human or a machine did the writing. The [analysis of the March 2026 spam update by Digital Applied](https://www.digitalapplied.com/blog/scaled-content-abuse-google-march-update-ai-pages-decimated) describes the pattern that got hit: sites publishing at very high daily volume with no editorial review, thin factual depth, and no first-hand experience.

The operative words are *no review* and *thin*. Volume alone is not the violation. A team publishing three substantive, sourced pieces a day is doing something categorically different from a site emitting hundreds of unreviewed variations on the same keyword. But the second pattern is easy to drift into when output is automated, which is why volume needs a quality floor attached to it rather than a target attached to it.

There is a second, quieter reason volume disappoints: generative engines deduplicate. Ten articles restating the same claim give the retriever ten near-identical candidate passages, and it will cite one. The marginal return on the other nine is close to zero.

## Should you implement llms.txt?

This one comes up constantly, and the honest answer is that it is not where your effort should go.

The proposal is reasonable on its face — a plain-text file telling language models how to read your site. But the adoption data undercuts it. Analysis compiled in [LLM Pulse's 2026 guide to the format](https://llmpulse.ai/blog/llms-txt-guide/) reports that while roughly one in ten sites now carries the file, monitoring of AI crawler traffic found it is requested in a vanishingly small fraction of visits, and the large majority of deployed files are never fetched at all. Google has stated publicly that it does not support the format and has no plans to.

It takes ten minutes and harms nothing. Just do not let it substitute for structured data, which the engines demonstrably do consume.

## What should you actually change?

Concretely, and in priority order:

1. **Put a direct answer at the top of every page.** Two or three sentences that resolve the title question without requiring the rest of the article. This is the passage most likely to be retrieved.
2. **Make headings match real questions.** Question-phrased headings align the embedding of the section with the embedding of the query.
3. **One idea per paragraph.** Write so that any single paragraph, lifted out and shown alone, still says something true and complete.
4. **Date and attribute every number.** A statistic without a year and a source is not a weak claim, it is an unusable one.
5. **Publish something only you have.** Benchmarks from your own systems, metrics from real projects, failure post-mortems. Original data is the one category competitors cannot replicate, and it is disproportionately cited because nothing else can serve as the source.
6. **Keep entity naming identical everywhere** — site, professional profiles, business listings, structured data.

## How do you measure whether any of this worked?

Badly, if you rely on the tools built for the previous era. Rank trackers report position for a query; they say nothing about whether an engine quoted you in an answer that never produced a click. Plugin "SEO scores" are worse than useless here, because they are proprietary checklists that no engine computes.

Three measurements that do mean something:

**Citation presence.** Run your target questions through the engines you care about — ChatGPT, Perplexity, Google's AI surfaces, Claude — on a fixed schedule, and record whether you appear and in what context. It is manual and slightly tedious, and it is the only direct read on the outcome you are optimising for. A monthly cadence against a stable list of ten to twenty questions is enough to see movement.

**Crawler access.** Check your logs or robots configuration to confirm the AI crawlers can actually reach you. Blocking them is a legitimate choice, but plenty of sites block them by accident through an inherited robots file and then wonder why they are never cited.

**Impressions, not just clicks.** Search Console impressions keep rising for content that feeds AI answers even when clicks flatten, because the answer resolves the question without a visit. Reading clicks alone will tell you the content failed when it may be doing exactly what you built it to do.

Expect this to be slow. A site with no established citation history does not appear in answers within weeks, and no amount of publishing volume compresses that.

## What does this mean in practice?

The uncomfortable implication is that GEO rewards a kind of writing that is slower to produce than what ranked well in the link-building era. Every claim needs provenance. Every section needs to stand alone. There is no volume strategy that substitutes for this, because the thing being selected is the quality of an individual passage, not the weight of a domain.

The comfortable implication is that it is winnable by small teams. A consultancy with genuine project data and the discipline to date its claims can be cited alongside far larger firms, because the retrieval layer is not asking who is bigger. It is asking which paragraph answers the question.

For more on how we think about retrieval systems generally, see our [generative engine optimization](/topics/geo) writing.
