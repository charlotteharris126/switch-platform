// Render canonical lead-payload values into provider-friendly labels.
// Falls back to a humanised slug if the value isn't in the lookup, so
// new schema values still display readably without a release.

const AGE_BAND: Record<string, string> = {
  "16_18": "16–18",
  "19_24": "19–24",
  "25_34": "25–34",
  "35_44": "35–44",
  "45_54": "45–54",
  "55_64": "55–64",
  "65_plus": "65+",
};

const EMPLOYMENT: Record<string, string> = {
  unemployed: "Unemployed",
  employed_full_time: "Employed full-time",
  employed_part_time: "Employed part-time",
  self_employed: "Self-employed",
  on_benefits: "On benefits",
  carer: "Carer",
  student: "Student",
  retired: "Retired",
  other: "Other",
};

const OUTCOME_INTEREST: Record<string, string> = {
  career_change: "Career change",
  upskill: "Upskill in current role",
  return_to_work: "Return to work",
  start_a_business: "Start a business",
  better_pay: "Better pay",
  more_flexibility: "More flexibility",
  qualification_only: "Qualification only",
  exploring: "Exploring options",
  other: "Other",
};

const FUNDING_CATEGORY: Record<string, string> = {
  gov: "Funded",
  self: "Self-funded",
  loan: "Loan-funded",
  apprentice: "Apprenticeship",
};

const FUNDING_ROUTE: Record<string, string> = {
  skills_bootcamp: "Skills Bootcamp",
  free_courses_for_jobs: "Free Courses for Jobs",
  multiply: "Multiply",
  adult_skills_fund: "Adult Skills Fund",
  advanced_learner_loan: "Advanced Learner Loan",
};

const START_TIMING: Record<string, string> = {
  asap: "As soon as possible",
  exploring: "Exploring options",
  later: "Later this year",
  next_year: "Next year",
};

export function labelAgeBand(v: string | null | undefined): string | null {
  if (!v) return null;
  return AGE_BAND[v] ?? humanise(v);
}

export function labelEmployment(v: string | null | undefined): string | null {
  if (!v) return null;
  return EMPLOYMENT[v] ?? humanise(v);
}

export function labelOutcomeInterest(v: string | null | undefined): string | null {
  if (!v) return null;
  return OUTCOME_INTEREST[v] ?? humanise(v);
}

export function labelStartTiming(v: string | null | undefined): string | null {
  if (!v) return null;
  return START_TIMING[v] ?? humanise(v);
}

export function labelFunding(
  category: string | null | undefined,
  route: string | null | undefined,
): string | null {
  const cat = category ? FUNDING_CATEGORY[category] ?? humanise(category) : null;
  const r = route ? FUNDING_ROUTE[route] ?? humanise(route) : null;
  if (cat && r) return `${cat} (${r})`;
  return cat ?? r ?? null;
}

// Course slugs like "smm-for-ecommerce-tees-valley". We don't have a course
// metadata table on the DB side, so we render slug → human title with a few
// term replacements + capitalisation. Looks better than the raw slug.
const TITLE_TERM_OVERRIDES: Record<string, string> = {
  smm: "Social Media Marketing",
  seo: "SEO",
  ai: "AI",
  it: "IT",
  hr: "HR",
  l3: "Level 3",
  l4: "Level 4",
  l5: "Level 5",
  l7: "Level 7",
  cscs: "CSCS",
  uk: "UK",
};

export function labelCourse(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return slug
    .split("-")
    .map((seg) => TITLE_TERM_OVERRIDES[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(" ");
}

function humanise(snake: string): string {
  return snake
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}
