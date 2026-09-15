/**
 * Single source of truth for entity data.
 *
 * Entity consistency matters for GEO: these exact strings must match the
 * LinkedIn page and Google Business Profile. Divergence splits the entity
 * and weakens citation confidence in generative engines.
 */
export const SITE = {
  name: 'Intelleo',
  legalName: 'Intelleo',
  url: 'https://www.intelleo.in',
  email: 'sandeep@intelleo.in',
  tagline: 'Deep Tech Consulting · AI, ML, Data & Software for AI',
  description:
    'Intelleo is a deep tech consulting firm. We turn AI into business value — from ML models in production to data pipelines, databases and RAG systems.',
  country: 'IN',
  defaultOgImage: '/og-default.png',
  // Add profiles as they go live — `sameAs` is a primary entity-resolution
  // signal for both Google's Knowledge Graph and generative engines.
  sameAs: [] as string[],
} as const;

export const AUTHOR = {
  name: 'Sandeep Katti',
  email: 'sandeep@intelleo.in',
  jobTitle: 'Founder, Intelleo',
  url: 'https://www.intelleo.in/about',
} as const;

/** Domain axis. Keys must stay in sync with the `cluster` enum and subjects.yaml. */
export const CLUSTERS = {
  ai: {
    label: 'Artificial Intelligence',
    blurb:
      'Creating business value with AI — identifying the use cases that matter and bringing them to life, from feasibility to a working solution your teams actually use.',
  },
  ml: {
    label: 'Machine Learning',
    blurb:
      'Building and deploying models that earn their keep — trained on your data, validated against your metrics, and shipped into production with monitoring from day one.',
  },
  data: {
    label: 'Data',
    blurb:
      'Architecting the backend pipelines that every model and dashboard depends on — reliable, observable, and built to scale with your business.',
  },
  'software-for-ai': {
    label: 'Software for AI',
    blurb:
      'The engineering that makes AI dependable: data pipelines, databases, retrieval-augmented generation and the surrounding systems that turn models into products.',
  },
  geo: {
    label: 'Generative Engine Optimization',
    blurb:
      'How large language models retrieve, rank and cite sources — treated as a retrieval and ranking problem rather than a marketing one.',
  },
} as const;

export type ClusterId = keyof typeof CLUSTERS;
export const CLUSTER_IDS = Object.keys(CLUSTERS) as ClusterId[];
