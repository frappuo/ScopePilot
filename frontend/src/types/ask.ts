// A cited reference passage (AskSource in backend/app/schemas/experiment.py). Reference material
// on the topic in general, never evidence about the student's image.
export type AskSource = {
  title: string;
  section: string | null;
  url: string;
  licence: string;
};

// ExperimentAskResponse: [n] in the answer is sources[n - 1]. sources is [] when none were used.
export type AskAnswer = {
  answer: string;
  sources: AskSource[];
};
