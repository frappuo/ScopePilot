import { useFocusEffect, usePreventRemove } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { AccessibilityInfo, Alert, Platform, View } from 'react-native';
import { createAiSession, type AiFailure } from '../api/aiSession';
import { dailyUsage, limitedUsage, useDailyUsage, type DailyUsageStore } from '../api/dailyUsage';
import type { LogbookApi } from '../api/logbookApi';
import { noteLogbookChanged } from '../api/logbookChanges';
import { useLogbookApi } from '../api/useLogbookApi';
import {
  AppText, Button, Card, Notice, OptionRow, Screen, ScreenHeading, SectionLabel, Stack, type Glyph,
} from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import type { DailyUsage } from '../types/experiment';
import type { Quiz, QuizQuestion } from '../types/quiz';
import { DISCLAIMER } from './copy';
import { MissingObservation } from './missingObservation';
import { errorToShow, limitReached, UsageStatus } from './usageStatus';

// A quiz on one observation's stored analysis (POST /v1/experiments/{id}/quiz). Generating one uses
// one of today's AI requests. The response carries the answers, so the screen shows only the
// current question and reveals its answer and explanation only after a choice.

export const QUIZ_TITLE = 'Quiz on this observation';
export const QUIZ_COST = "Generating a quiz uses one of today's AI requests.";
export const GENERATING = 'Generating a quiz. This can take up to a minute.';
// Lets the result announcement finish before focus moves (and VoiceOver reads) the explanation.
export const FOCUS_AFTER_ANNOUNCE_MS = 700;

export type QuizPhase =
  | { kind: 'intro' }
  | { kind: 'loading' }
  // answers[i] is the option chosen for question i, or null until then.
  | { kind: 'question'; quiz: Quiz; index: number; answers: (string | null)[] }
  | { kind: 'score'; quiz: Quiz; answers: (string | null)[] }
  | { kind: 'gone' };

export function startQuiz(quiz: Quiz): QuizPhase {
  return { kind: 'question', quiz, index: 0, answers: quiz.questions.map(() => null) };
}

// The first choice locks the question; later taps change nothing.
export function chooseOption(phase: QuizPhase, option: string): QuizPhase {
  if (phase.kind !== 'question' || phase.answers[phase.index] !== null) return phase;
  if (!phase.quiz.questions[phase.index].options.includes(option)) return phase;
  const answers = [...phase.answers];
  answers[phase.index] = option;
  return { ...phase, answers };
}

// Next question, or the score after the last one. Only after a choice.
export function nextStep(phase: QuizPhase): QuizPhase {
  if (phase.kind !== 'question' || phase.answers[phase.index] === null) return phase;
  return phase.index + 1 < phase.quiz.questions.length
    ? { ...phase, index: phase.index + 1 }
    : { kind: 'score', quiz: phase.quiz, answers: phase.answers };
}

export function scoreOf(quiz: Quiz, answers: (string | null)[]): number {
  return quiz.questions.filter((question, index) => answers[index] === question.correct_answer).length;
}

export function scoreLine(quiz: Quiz, answers: (string | null)[]): string {
  return `${scoreOf(quiz, answers)} of ${quiz.questions.length} correct`;
}

export function resultAnnouncement(question: QuizQuestion, chosen: string): string {
  return chosen === question.correct_answer ? 'Correct' : `Incorrect. The correct answer is ${question.correct_answer}`;
}

// What an option says once a choice is made: nothing before it.
export function optionMark(question: QuizQuestion, option: string, chosen: string | null): { glyph: Glyph; note: string } | null {
  if (chosen === null) return null;
  if (option === chosen) {
    return chosen === question.correct_answer
      ? { glyph: 'correct', note: 'Your answer, correct' }
      : { glyph: 'incorrect', note: 'Your answer, incorrect' };
  }
  return option === question.correct_answer ? { glyph: 'correct', note: 'Correct answer' } : null;
}

export type QuizOutcome = { ok: true; quiz: Quiz } | AiFailure;

// One per screen (src/api/aiSession.ts): the guard covers Start and New quiz alike.
export function createQuizSession(
  api: Pick<LogbookApi, 'quizExperiment' | 'getMe'>, id: string,
  usage: Pick<DailyUsageStore, 'refreshAfter'> = dailyUsage,
) {
  const session = createAiSession(api, usage);

  // null when a quiz is already being generated, or the screen has left.
  async function start(): Promise<QuizOutcome | null> {
    const result = await session.run(signal => api.quizExperiment(id, { signal }));
    if (!result || !result.ok) return result;
    return { ok: true, quiz: result.value };
  }

  return { start, dispose: session.dispose };
}

export type QuizSession = ReturnType<typeof createQuizSession>;

export function confirmNewQuiz(onConfirm: () => void): void {
  Alert.alert('Start a new quiz?', "A new quiz uses one of today's AI requests.", [
    { text: 'Cancel', style: 'cancel' },
    { text: 'New quiz', onPress: onConfirm },
  ]);
}

export function confirmLeave(onLeave: () => void): void {
  Alert.alert('Leave this quiz?', "Your answers won't be kept. Coming back starts a new quiz, which uses another of today's AI requests.", [
    { text: 'Stay', style: 'cancel' },
    { text: 'Leave', style: 'destructive', onPress: onLeave },
  ]);
}

// Leaving is confirmed only while a loaded quiz is in progress.
export function confirmsLeaving(phase: QuizPhase): boolean {
  return phase.kind === 'question';
}

export type QuizViewProps = {
  phase: QuizPhase;
  error: string | null;
  usage: DailyUsage | null;
  questionRef?: Ref<View>;
  explanationRef?: Ref<View>;
  onStart(): void;
  onChoose(option: string): void;
  onNext(): void;
  onNewQuiz(): void;
  onBackToObservation(): void;
  onBack(): void;
};

function Footer({ children }: { children?: ReactNode }) {
  return <Stack>
    {children}
    <AppText variant="caption">{DISCLAIMER}</AppText>
  </Stack>;
}

export function QuizView({
  phase, error, usage, questionRef, explanationRef, onStart, onChoose, onNext, onNewQuiz, onBackToObservation, onBack,
}: QuizViewProps) {
  if (phase.kind === 'gone') return <MissingObservation onBack={onBack} />;

  if (phase.kind === 'question') {
    const { quiz, index, answers } = phase;
    const question = quiz.questions[index];
    const chosen = answers[index];
    const total = quiz.questions.length;
    const position = `Question ${index + 1} of ${total}`;
    return <Screen fill footer={<Footer>
      {chosen !== null
        ? <Button size="large" title={index + 1 < total ? 'Next' : 'See score'} onPress={onNext} />
        : null}
    </Footer>}>
      <View ref={questionRef} accessible accessibilityRole="header" accessibilityLabel={position}>
        <AppText variant="label">{position}</AppText>
      </View>
      <AppText variant="headline">{question.question}</AppText>
      <Stack>
        {question.options.map(option => {
          const mark = optionMark(question, option, chosen);
          return <OptionRow key={option} label={option} checked={option === chosen} disabled={chosen !== null}
            glyph={mark?.glyph} note={mark?.note} onPress={() => onChoose(option)} />;
        })}
      </Stack>
      {chosen !== null
        ? <View ref={explanationRef} accessible accessibilityLabel={`Explanation: ${question.explanation}`}>
          <Card>
            <SectionLabel title="Explanation" />
            <AppText>{question.explanation}</AppText>
          </Card>
        </View>
        : null}
    </Screen>;
  }

  if (phase.kind === 'score') {
    return <Screen fill footer={<Footer>
      <Button size="large" title="Back to observation" onPress={onBackToObservation} />
      <Button variant="secondary" title="New quiz" onPress={onNewQuiz} disabled={limitReached(usage)} />
    </Footer>}>
      <ScreenHeading title="Quiz complete" />
      <AppText variant="title">{scoreLine(phase.quiz, phase.answers)}</AppText>
      <UsageStatus usage={usage} />
    </Screen>;
  }

  // Intro and loading. A failed Start or New quiz comes back here with its message.
  const loading = phase.kind === 'loading';
  return <Screen fill footer={<Footer>
    <Button size="large" title="Start" accessibilityLabel="Start quiz" onPress={onStart} busy={loading}
      disabled={limitReached(usage)} />
  </Footer>}>
    <ScreenHeading title={QUIZ_TITLE} />
    <AppText>{QUIZ_COST}</AppText>
    <UsageStatus usage={usage} />
    {loading ? <Notice kind="info">{GENERATING}</Notice> : null}
    {error ? <Notice kind="error">{error}</Notice> : null}
  </Screen>;
}

export default function QuizExperimentScreen({ navigation, route }: ScreenProps<'QuizExperiment'>) {
  const { id } = route.params;
  const api = useLogbookApi();
  const usage = limitedUsage(useDailyUsage());
  const [phase, setPhase] = useState<QuizPhase>({ kind: 'intro' });
  const [error, setError] = useState<string | null>(null);
  const session = useRef<QuizSession | null>(null);
  const questionRef = useRef<View>(null);
  const explanationRef = useRef<View>(null);

  useEffect(() => {
    const created = createQuizSession(api, id);
    session.current = created;
    return () => {
      created.dispose();
      if (session.current === created) session.current = null;
    };
  }, [api, id]);

  useFocusEffect(useCallback(() => { void dailyUsage.refreshIfStale(api); }, [api]));

  // Coming back would cost another request. Covers the back button, the iOS swipe and Android back.
  usePreventRemove(confirmsLeaving(phase), ({ data }) => confirmLeave(() => navigation.dispatch(data.action)));

  const questionIndex = phase.kind === 'question' ? phase.index : -1;
  const chosen = phase.kind === 'question' ? phase.answers[phase.index] : null;
  const current = phase.kind === 'question' ? phase.quiz.questions[phase.index] : null;

  // A new question (the first, or after Next): focus its "Question N of T".
  useEffect(() => {
    if (questionIndex >= 0 && questionRef.current) AccessibilityInfo.sendAccessibilityEvent(questionRef.current, 'focus');
  }, [questionIndex]);

  // A choice: say the result, then move focus to the explanation.
  useEffect(() => {
    if (chosen === null || !current) return;
    AccessibilityInfo.announceForAccessibility(resultAnnouncement(current, chosen));
    const timer = setTimeout(() => {
      if (explanationRef.current) AccessibilityInfo.sendAccessibilityEvent(explanationRef.current, 'focus');
    }, FOCUS_AFTER_ANNOUNCE_MS);
    return () => clearTimeout(timer);
  }, [chosen, current]);

  const score = phase.kind === 'score' ? scoreLine(phase.quiz, phase.answers) : null;
  useEffect(() => {
    if (score) AccessibilityInfo.announceForAccessibility(score);
  }, [score]);

  async function start() {
    const running = session.current;
    if (!running || phase.kind === 'loading' || limitReached(usage)) return;
    setError(null);
    setPhase({ kind: 'loading' });
    const outcome = await running.start();
    // null: a quiz is already being generated (it will settle the screen), or the screen has left.
    if (!outcome) return;
    if (outcome.ok) { setPhase(startQuiz(outcome.quiz)); return; }
    if (outcome.kind === 'not_found') {
      // Deleted elsewhere: the list reloads on its next focus.
      noteLogbookChanged();
      setPhase({ kind: 'gone' });
      return;
    }
    // Back to the intro, where Start is the retry. A 429 shows only the limit warning.
    const shown = errorToShow(outcome, limitedUsage(dailyUsage.getState()));
    setError(shown);
    setPhase({ kind: 'intro' });
    // Android reads the notice through its live region; iOS needs an announcement.
    if (shown && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(shown);
  }

  return <QuizView phase={phase} error={error} usage={usage} questionRef={questionRef} explanationRef={explanationRef}
    onStart={() => { void start(); }}
    onChoose={option => setPhase(currentPhase => chooseOption(currentPhase, option))}
    onNext={() => setPhase(currentPhase => nextStep(currentPhase))}
    onNewQuiz={() => confirmNewQuiz(() => { void start(); })}
    onBackToObservation={() => navigation.goBack()}
    onBack={() => navigation.popToTop()} />;
}
