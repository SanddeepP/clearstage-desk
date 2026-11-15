// Confirmed requirements cards for the seed roles (version 1). In the product Desk drafts these from the
// job description and the recruiter confirms or edits them; screening never runs before confirmation.
// "terms" are synonyms: a quote must mention the requirement or one of these to count.
export const REQUIREMENTS = {
  "Backend Developer": {
    id: "req-backend-developer", role: "Backend Developer", version: 1, confirmed: true,
    must: [
      { id: "m1", label: "Backend services in Go or Java", terms: ["Go", "Golang", "Java", "Spring Boot"] },
      { id: "m2", label: "REST API design", terms: ["REST", "API", "APIs", "endpoints"] },
      { id: "m3", label: "SQL databases (PostgreSQL or MySQL)", terms: ["SQL", "PostgreSQL", "Postgres", "MySQL"] },
      { id: "m4", label: "Message queues (Kafka or RabbitMQ)", terms: ["Kafka", "RabbitMQ", "message queue", "SQS"] },
      { id: "m5", label: "Payments or fintech systems", terms: ["payment", "payments", "payouts", "fintech", "UPI", "lending", "wallet", "settlement"] },
    ],
    nice: [
      { id: "n1", label: "Docker or Kubernetes", terms: ["Docker", "Kubernetes", "K8s"] },
      { id: "n2", label: "AWS or GCP", terms: ["AWS", "GCP", "Google Cloud"] },
      { id: "n3", label: "Redis caching", terms: ["Redis"] },
      { id: "n4", label: "Automated testing", terms: ["unit test", "tests", "testing", "TDD"] },
    ],
    experience: { min: 3, max: 6 },
    conditions: [
      { id: "c1", label: "Works from Hyderabad or will relocate", terms: ["Hyderabad", "relocate"] },
      { id: "c2", label: "Can join within 60 days", terms: ["notice period", "immediate joiner", "join"] },
    ],
    weights: { must: 60, experience: 20, nice: 15, conditions: 5 },
    drafted_from: "Job description for Backend Developer, Acme Fintech, Hyderabad, ₹10–14 L",
  },
  "Operations Analyst": {
    id: "req-operations-analyst", role: "Operations Analyst", version: 1, confirmed: true,
    must: [
      { id: "o1", label: "Excel (pivot tables, lookups)", terms: ["Excel", "pivot", "VLOOKUP", "XLOOKUP"] },
      { id: "o2", label: "SQL basics", terms: ["SQL"] },
      { id: "o3", label: "Reports or dashboards", terms: ["report", "reports", "dashboard", "MIS", "Power BI", "Tableau"] },
      { id: "o4", label: "Operations or process work", terms: ["operations", "process", "reconciliation", "SLA"] },
    ],
    nice: [
      { id: "p1", label: "Power BI or Tableau", terms: ["Power BI", "Tableau"] },
      { id: "p2", label: "Python", terms: ["Python"] },
      { id: "p3", label: "Fintech domain", terms: ["fintech", "lending", "payments"] },
    ],
    experience: { min: 1, max: 3 },
    conditions: [
      { id: "c1", label: "Works from Hyderabad or will relocate", terms: ["Hyderabad", "relocate"] },
      { id: "c2", label: "Can join within 30 days", terms: ["notice period", "immediate joiner", "join"] },
    ],
    weights: { must: 60, experience: 20, nice: 15, conditions: 5 },
    drafted_from: "Job description for Operations Analyst, Acme Fintech, Hyderabad, ₹5–7 L",
  },
};
