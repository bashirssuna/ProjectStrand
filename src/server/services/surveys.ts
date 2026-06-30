import "server-only";
import { q, one } from "@/server/db";

export const QUESTION_TYPES = ["scale", "rating", "single_choice", "yes_no", "text"] as const;
export const SCALE_LABELS = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];
export const typeLabel = (t: string) =>
  ({ scale: "Agreement scale (1–5)", rating: "Rating (1–5)", single_choice: "Multiple choice", yes_no: "Yes / No", text: "Free text" }[t] ?? t);

export type SurveyRow = { id: string; title: string; status: string; anonymous: boolean; questions: number; responses: number; createdAt: string };
export async function listSurveys(orgId: string): Promise<SurveyRow[]> {
  return q<SurveyRow>(
    `SELECT s.id, s.title, s.status, s.anonymous, s.created_at AS "createdAt",
            (SELECT COUNT(*) FROM survey_question x WHERE x.survey_id=s.id)::int AS questions,
            (SELECT COUNT(*) FROM survey_response r WHERE r.survey_id=s.id)::int AS responses
     FROM survey s WHERE s.org_id=$1 ORDER BY s.created_at DESC`, [orgId]);
}

export type SurveyDetail = {
  id: string; token: string; title: string; description: string | null; intro: string | null; thankYou: string | null;
  anonymous: boolean; status: string; responses: number;
};
const DCOLS = `s.id, s.token, s.title, s.description, s.intro, s.thank_you AS "thankYou", s.anonymous, s.status,
  (SELECT COUNT(*) FROM survey_response r WHERE r.survey_id=s.id)::int AS responses`;
export async function getSurvey(orgId: string, id: string): Promise<SurveyDetail | null> {
  return one<SurveyDetail>(`SELECT ${DCOLS} FROM survey s WHERE s.id=$1 AND s.org_id=$2`, [id, orgId]);
}
// Public: only resolves an OPEN survey (the token is the access link).
export async function getOpenSurveyByToken(token: string): Promise<(SurveyDetail & { orgName: string }) | null> {
  return one<SurveyDetail & { orgName: string }>(
    `SELECT ${DCOLS}, o.name AS "orgName" FROM survey s JOIN organization o ON o.id=s.org_id WHERE s.token=$1 AND s.status='open'`, [token]);
}

export type Question = { id: string; prompt: string; type: string; options: string | null; required: boolean; sortOrder: number };
export async function listQuestions(orgId: string, surveyId: string): Promise<Question[]> {
  return q<Question>(
    `SELECT id, prompt, type, options, required, sort_order AS "sortOrder" FROM survey_question
     WHERE survey_id=$1 AND org_id=$2 ORDER BY sort_order, created_at`, [surveyId, orgId]);
}
export const parseOptions = (opts: string | null): string[] =>
  (opts || "").split("\n").map((o) => o.trim()).filter(Boolean);

// Public: questions for a survey already resolved by token (survey_id is trusted).
export async function listPublicQuestions(surveyId: string): Promise<Question[]> {
  return q<Question>(
    `SELECT id, prompt, type, options, required, sort_order AS "sortOrder" FROM survey_question
     WHERE survey_id=$1 ORDER BY sort_order, created_at`, [surveyId]);
}

// ---- Results aggregation ----
export type QuestionResult = {
  id: string; prompt: string; type: string; answered: number;
  average: number | null;                       // scale/rating
  distribution: { label: string; value: number; count: number }[]; // scale/rating/yes_no/single_choice
  texts: string[];                              // text answers
};
export type SurveyResults = {
  responses: number; engagementScore: number | null; scaleQuestions: number;
  questions: QuestionResult[];
};
export async function surveyResults(orgId: string, surveyId: string): Promise<SurveyResults> {
  const responses = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM survey_response WHERE survey_id=$1 AND org_id=$2`, [surveyId, orgId]))?.c ?? 0;
  const questions = await listQuestions(orgId, surveyId);
  const out: QuestionResult[] = [];
  let scaleSum = 0, scaleN = 0, scaleQ = 0;

  for (const ques of questions) {
    const answered = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM survey_answer WHERE question_id=$1`, [ques.id]))?.c ?? 0;
    const r: QuestionResult = { id: ques.id, prompt: ques.prompt, type: ques.type, answered, average: null, distribution: [], texts: [] };

    if (ques.type === "scale" || ques.type === "rating") {
      const avg = await one<{ a: number | null }>(`SELECT AVG(value_num)::float8 a FROM survey_answer WHERE question_id=$1 AND value_num IS NOT NULL`, [ques.id]);
      r.average = avg?.a != null ? Math.round(avg.a * 100) / 100 : null;
      const counts = await q<{ v: number; c: number }>(`SELECT value_num::int v, COUNT(*)::int c FROM survey_answer WHERE question_id=$1 AND value_num IS NOT NULL GROUP BY value_num`, [ques.id]);
      const map = new Map(counts.map((c) => [c.v, c.c]));
      for (let v = 1; v <= 5; v++) r.distribution.push({ label: ques.type === "scale" ? SCALE_LABELS[v - 1] : String(v), value: v, count: map.get(v) ?? 0 });
      if (ques.type === "scale" && r.average != null) { scaleSum += avg!.a!; scaleN += 1; }
      if (ques.type === "scale") scaleQ += 1;
    } else if (ques.type === "yes_no") {
      const counts = await q<{ v: number; c: number }>(`SELECT value_num::int v, COUNT(*)::int c FROM survey_answer WHERE question_id=$1 AND value_num IS NOT NULL GROUP BY value_num`, [ques.id]);
      const map = new Map(counts.map((c) => [c.v, c.c]));
      r.distribution = [{ label: "Yes", value: 1, count: map.get(1) ?? 0 }, { label: "No", value: 0, count: map.get(0) ?? 0 }];
    } else if (ques.type === "single_choice") {
      const counts = await q<{ v: string; c: number }>(`SELECT value_text v, COUNT(*)::int c FROM survey_answer WHERE question_id=$1 AND value_text IS NOT NULL GROUP BY value_text`, [ques.id]);
      const optList = parseOptions(ques.options);
      const map = new Map(counts.map((c) => [c.v, c.c]));
      r.distribution = (optList.length ? optList : counts.map((c) => c.v)).map((o, i) => ({ label: o, value: i, count: map.get(o) ?? 0 }));
    } else if (ques.type === "text") {
      const rows = await q<{ t: string }>(`SELECT value_text t FROM survey_answer WHERE question_id=$1 AND value_text IS NOT NULL AND value_text <> '' ORDER BY id`, [ques.id]);
      r.texts = rows.map((x) => x.t);
    }
    out.push(r);
  }
  // engagement score = mean of scale-question averages, on a 0–100 scale
  const engagementScore = scaleN > 0 ? Math.round(((scaleSum / scaleN) / 5) * 1000) / 10 : null;
  return { responses, engagementScore, scaleQuestions: scaleQ, questions: out };
}
