import type { Analysis } from './analysis';

export type QuizQuestion = {
  question: string;
  options: [string, string, string, string];
  correct_answer: string;
  explanation: string;
};

export type Quiz = {
  questions: [QuizQuestion, QuizQuestion, QuizQuestion];
};

export type QuizRequest = {
  analysis: Analysis;
};
