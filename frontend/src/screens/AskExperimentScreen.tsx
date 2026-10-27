import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import { AccessibilityInfo, Linking, Platform, View, type ScrollView } from 'react-native';
import { createAiSession, type AiFailure } from '../api/aiSession';
import { sanitizeAnswer } from '../api/answerText';
import { dailyUsage, limitedUsage, useDailyUsage, type DailyUsageStore } from '../api/dailyUsage';
import { MESSAGES } from '../api/http';
import { isHttpsUrl, QUESTION_MAX, questionLength, stripLikePython, type LogbookApi } from '../api/logbookApi';
import { noteLogbookChanged } from '../api/logbookChanges';
import { useLogbookApi } from '../api/useLogbookApi';
import {
  AppText, Button, Card, FieldGroup, FieldRow, Group, Notice, Pill, Screen, ScreenHeading, Stack, TextLink,
} from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import type { AskSource } from '../types/ask';
import type { DailyUsage } from '../types/experiment';
import { DISCLAIMER } from './copy';
import { MissingObservation } from './missingObservation';
import { errorToShow, limitReached, UsageStatus } from './usageStatus';

// Questions about one observation's stored analysis (POST /v1/experiments/{id}/ask). Each question
// uses one of today's AI requests. Nothing is stored: the exchanges live only while the screen is open.

export const ASK_TITLE = 'Ask about this observation';
export const ASK_SUBTITLE = "Questions about this observation's analysis. Answers aren't saved after you leave.";
export const EMPTY_LINE = 'Your questions and answers will appear here.';
export const ANSWER_RECEIVED = 'Answer received';
// TextInput's maxLength counts UTF-16 units, so it only stops runaway pastes; the 500 code-point
// limit is checked with questionLength, as askExperiment does.
export const QUESTION_INPUT_MAX = QUESTION_MAX * 2;

// Under an answer that cites reference passages. They explain the topic in general and never
// say what the image shows; the student checks that at the microscope.
export const SOURCES_LABEL = 'Sources';
export const SOURCES_NOTE = 'Reference material on the topic, not evidence about your image.';
export const OPEN_SOURCE = 'Open source';

// [n] in the answer is sources[n - 1]. Missing or [] shows no Sources section.
export type Exchange = { key: number; question: string; answer: string; sources?: AskSource[] };

export function sourceHeading(source: AskSource, index: number): string {
  return `${index + 1}. ${source.title}${source.section ? ` — ${source.section}` : ''}`;
}

// https only, as parseSource already checked; a link that cannot open does nothing.
export function openSource(url: string, open: (url: string) => Promise<unknown> = target => Linking.openURL(target)): void {
  if (!isHttpsUrl(url)) return;
  open(url).catch(() => {});
}

function Sources({ sources }: { sources: AskSource[] }) {
  return <Group>
    <AppText variant="label">{SOURCES_LABEL}</AppText>
    <AppText variant="caption" tone="muted">{SOURCES_NOTE}</AppText>
    {sources.map((source, index) => <Group key={index}>
      <AppText>{sourceHeading(source, index)}</AppText>
      <AppText variant="caption" tone="muted">{`Licence: ${source.licence}`}</AppText>
      <TextLink title={OPEN_SOURCE} accessibilityLabel={`${OPEN_SOURCE} ${index + 1}, ${source.title}`}
        onPress={() => openSource(source.url)} />
    </Group>)}
  </Group>;
}

// Space kept above "You asked" when scrolling to a new exchange.
export const SCROLL_MARGIN = 16;

// Where to scroll for a new exchange laid out at `y` in the content: its top, a little above.
// The ScrollView clamps the offset, so when everything fits nothing visibly moves.
export function exchangeScrollTarget(y: number, margin = SCROLL_MARGIN): number {
  return Math.max(0, y - margin);
}

export type SendBlock = 'empty' | 'too_long' | 'busy' | 'limit';

// Why Send is disabled, or null when it is enabled.
export function sendBlock(question: string, busy: boolean, usage: DailyUsage | null): SendBlock | null {
  const length = questionLength(question);
  if (busy) return 'busy';
  if (limitReached(usage)) return 'limit';
  if (length < 1) return 'empty';
  return length > QUESTION_MAX ? 'too_long' : null;
}

// "N/500"; over the limit, the words say so as well as the colour.
export function questionCounter(question: string): { text: string; label: string; over: boolean } {
  const length = questionLength(question);
  const over = length - QUESTION_MAX;
  return over > 0
    ? { text: `${length}/${QUESTION_MAX} · ${over} over the limit`, label: `${length} of ${QUESTION_MAX} characters, ${over} over the limit`, over: true }
    : { text: `${length}/${QUESTION_MAX}`, label: `${length} of ${QUESTION_MAX} characters`, over: false };
}

export type AskOutcome = { ok: true; question: string; answer: string; sources: AskSource[] } | AiFailure;

// One per screen (src/api/aiSession.ts): the double-submit guard, the abort on unmount, and the
// usage refresh after every outcome.
export function createAskSession(
  api: Pick<LogbookApi, 'askExperiment' | 'getMe'>, id: string,
  usage: Pick<DailyUsageStore, 'refreshAfter'> = dailyUsage,
) {
  const session = createAiSession(api, usage);

  // null when a question is already being sent, or the screen has left.
  async function send(question: string): Promise<AskOutcome | null> {
    const result = await session.run(signal => api.askExperiment(id, question, { signal }));
    if (!result || !result.ok) return result;
    // parseAnswer checked it is non-empty; Markdown markers alone would leave nothing to show.
    if (!sanitizeAnswer(result.value.answer)) return { ok: false, kind: 'bad_response', message: MESSAGES.badResponse };
    return { ok: true, question: stripLikePython(question), answer: result.value.answer, sources: result.value.sources };
  }

  return { send, dispose: session.dispose };
}

export type AskSession = ReturnType<typeof createAskSession>;

export type AskViewProps = {
  exchanges: Exchange[];
  question: string;
  busy: boolean;
  error: string | null;
  // The observation is gone (404): the body is replaced with the way back.
  gone: boolean;
  usage: DailyUsage | null;
  // Attached to the newest answer's label, so focus can move there.
  answerRef?: Ref<View>;
  scrollRef?: Ref<ScrollView>;
  // Each exchange's y offset in the scrolling content, as it lays out.
  onExchangeLayout?(key: number, y: number): void;
  onChangeQuestion(text: string): void;
  onSend(): void;
  onBack(): void;
};

export function AskView({
  exchanges, question, busy, error, gone, usage, answerRef, scrollRef, onExchangeLayout, onChangeQuestion, onSend, onBack,
}: AskViewProps) {
  if (gone) return <MissingObservation onBack={onBack} />;
  const counter = questionCounter(question);
  const blocked = sendBlock(question, busy, usage);
  return <Screen fill scrollRef={scrollRef} footer={<Stack>
    <FieldGroup>
      <FieldRow label="Your question" placeholder="Ask about the analysis" value={question} onChangeText={onChangeQuestion}
        multiline textAlignVertical="top" maxLength={QUESTION_INPUT_MAX} editable={!busy} />
    </FieldGroup>
    <AppText variant="caption" tone={counter.over ? 'danger' : 'muted'} accessibilityLabel={counter.label}>{counter.text}</AppText>
    <Button size="large" title="Send" accessibilityLabel="Send question" onPress={onSend} busy={busy} disabled={blocked !== null} />
    <AppText variant="caption">{DISCLAIMER}</AppText>
  </Stack>}>
    <ScreenHeading title={ASK_TITLE} subtitle={ASK_SUBTITLE} />
    <UsageStatus usage={usage} />
    {exchanges.length
      // The wrapper is a direct child of the scrolling content, so its layout y is the scroll offset.
      ? exchanges.map((exchange, index) => <View key={exchange.key}
        onLayout={onExchangeLayout ? event => onExchangeLayout(exchange.key, event.nativeEvent.layout.y) : undefined}><Card>
        <Group>
          <AppText variant="label">You asked</AppText>
          <AppText>{exchange.question}</AppText>
        </Group>
        <View ref={index === exchanges.length - 1 ? answerRef : undefined} accessible accessibilityRole="header"
          accessibilityLabel="Answer, AI-generated">
          <Group>
            <AppText variant="label">Answer</AppText>
            <Pill label="AI-generated" />
          </Group>
        </View>
        <AppText selectable>{sanitizeAnswer(exchange.answer)}</AppText>
        {exchange.sources?.length ? <Sources sources={exchange.sources} /> : null}
      </Card></View>)
      : <AppText tone="muted">{EMPTY_LINE}</AppText>}
    {error ? <Notice kind="error">{error}</Notice> : null}
  </Screen>;
}

export default function AskExperimentScreen({ navigation, route }: ScreenProps<'AskExperiment'>) {
  const { id } = route.params;
  const api = useLogbookApi();
  const usage = limitedUsage(useDailyUsage());
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const session = useRef<AskSession | null>(null);
  const answerRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  // The exchange to scroll to once it has laid out; later relayouts of it do not scroll again.
  const scrollPending = useRef<number | null>(null);
  const nextKey = useRef(0);
  const announced = useRef(0);

  useEffect(() => {
    const created = createAskSession(api, id);
    session.current = created;
    return () => {
      created.dispose();
      if (session.current === created) session.current = null;
    };
  }, [api, id]);

  useFocusEffect(useCallback(() => { void dailyUsage.refreshIfStale(api); }, [api]));

  // A new answer: say so, then move focus to its label.
  useEffect(() => {
    if (exchanges.length <= announced.current) return;
    announced.current = exchanges.length;
    if (answerRef.current) AccessibilityInfo.sendAccessibilityEvent(answerRef.current, 'focus');
    AccessibilityInfo.announceForAccessibilityWithOptions(ANSWER_RECEIVED, { queue: true });
  }, [exchanges.length]);

  async function send() {
    const current = session.current;
    if (!current || sendBlock(question, busy, usage)) return;
    const asked = question;
    setBusy(true);
    setError(null);
    const outcome = await current.send(asked);
    // null: another send is running (it will finish the busy state), or the screen has left.
    if (!outcome) return;
    setBusy(false);
    if (outcome.ok) {
      const key = nextKey.current++;
      scrollPending.current = key;
      setExchanges(list => [...list, { key, question: outcome.question, answer: outcome.answer, sources: outcome.sources }]);
      setQuestion('');
      return;
    }
    if (outcome.kind === 'not_found') {
      // Deleted elsewhere: the list reloads on its next focus.
      noteLogbookChanged();
      setGone(true);
      return;
    }
    // The question stays in the field, so Send is the retry. A 429 shows only the limit warning.
    const shown = errorToShow(outcome, limitedUsage(dailyUsage.getState()));
    setError(shown);
    // Android reads the notice through its live region; iOS needs an announcement.
    if (shown && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(shown);
  }

  const onExchangeLayout = useCallback((key: number, y: number) => {
    if (scrollPending.current !== key) return;
    scrollPending.current = null;
    scrollRef.current?.scrollTo({ y: exchangeScrollTarget(y), animated: true });
  }, []);

  return <AskView exchanges={exchanges} question={question} busy={busy} error={error} gone={gone} usage={usage}
    answerRef={answerRef} scrollRef={scrollRef} onExchangeLayout={onExchangeLayout} onChangeQuestion={setQuestion} onSend={() => { void send(); }}
    onBack={() => navigation.popToTop()} />;
}
