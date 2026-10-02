import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Dimensions, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { analyzeImage, askQuestion, generateQuiz } from '../services/api';
import { selectImage } from '../services/images';
import type { Analysis, SelectedImage } from '../types/analysis';
import type { Quiz } from '../types/quiz';
import HealthDiagnostic from '../components/HealthDiagnostic';

function Section({ title, content }: { title: string; content: string | string[] }) {
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
    {Array.isArray(content)
      ? content.length ? content.map((item, index) => <Text key={index} style={styles.body}>• {item}</Text>)
        : <Text style={styles.body}>None reported.</Text>
      : <Text style={styles.body}>{content}</Text>}
  </View>;
}

export default function AnalysisScreen() {
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [quizLoading, setQuizLoading] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [answeredCurrentQuestion, setAnsweredCurrentQuestion] = useState(false);
  const [stage, setStage] = useState<'idle' | 'selecting' | 'analyzing'>('idle');
  const busy = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const questionContainer = useRef<View>(null);
  const scrollOffset = useRef(0);
  const unavailable = stage !== 'idle' || isAsking || quizLoading;

  function scrollQuestionIntoView(keyboardTop?: number) {
    const scrollView = scroll.current;
    const controls = questionContainer.current;
    if (!scrollView || !controls) return;
    controls.measureInWindow((_x: number, inputY: number, _width: number, inputHeight: number) => {
      const viewportBottom = (keyboardTop ?? Dimensions.get('window').height) - 32;
      const overlap = inputY + inputHeight - viewportBottom;
      if (overlap > 0) {
        scrollView.scrollTo({ y: Math.max(0, scrollOffset.current + overlap), animated: true });
      }
    });
  }

  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', ({ endCoordinates }) => {
      scrollQuestionIntoView(endCoordinates.screenY);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!answer) return;
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 100);
    return () => clearTimeout(timer);
  }, [answer]);

  function clearFollowUp() {
    setQuestion(''); setAnswer(null); setAskError(null);
  }

  function clearQuiz() {
    setQuizLoading(false); setQuizError(null); setQuiz(null);
    setCurrentQuestionIndex(0); setSelectedAnswer(null); setScore(0);
    setAnsweredCurrentQuestion(false);
  }

  async function pick() {
    if (busy.current) return;
    busy.current = true;
    setStage('selecting'); setError(null);
    try {
      const selected = await selectImage();
      if (selected) { setImage(selected); setResult(null); clearFollowUp(); clearQuiz(); }
    } catch { setError('Could not open this photo. Check photo access in your phone settings or try another image.'); }
    finally { busy.current = false; setStage('idle'); }
  }

  async function analyze() {
    if (busy.current) return;
    if (!image) { setError('Select a microscopy image first.'); return; }
    busy.current = true;
    setStage('analyzing'); setError(null); setResult(null); clearFollowUp(); clearQuiz();
    try { setResult(await analyzeImage(image)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Analysis failed. Please try again.'); }
    finally { busy.current = false; setStage('idle'); }
  }

  async function ask() {
    if (busy.current || isAsking) return;
    if (!result) return;
    if (!question.trim()) { setAskError('Enter a question about this analysis.'); return; }
    busy.current = true;
    setIsAsking(true); setAskError(null); setAnswer(null);
    try { setAnswer(await askQuestion(result, question)); }
    catch (failure) { setAskError(failure instanceof Error ? failure.message : 'Could not answer this question. Please try again.'); }
    finally { busy.current = false; setIsAsking(false); }
  }

  async function startQuiz() {
    if (busy.current || quizLoading || !result) return;
    busy.current = true;
    setQuizLoading(true); setQuizError(null); setQuiz(null);
    setCurrentQuestionIndex(0); setSelectedAnswer(null); setScore(0);
    setAnsweredCurrentQuestion(false);
    try { setQuiz(await generateQuiz(result)); }
    catch (failure) { setQuizError(failure instanceof Error ? failure.message : 'Could not generate a quiz. Please try again.'); }
    finally { busy.current = false; setQuizLoading(false); }
  }

  function selectAnswer(option: string) {
    if (!quiz || answeredCurrentQuestion) return;
    const current = quiz.questions[currentQuestionIndex];
    setSelectedAnswer(option); setAnsweredCurrentQuestion(true);
    if (option === current.correct_answer) setScore(previous => previous + 1);
  }

  function nextQuestion() {
    if (!quiz || !answeredCurrentQuestion || currentQuestionIndex >= quiz.questions.length - 1) return;
    setCurrentQuestionIndex(previous => previous + 1);
    setSelectedAnswer(null); setAnsweredCurrentQuestion(false);
  }

  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}>
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      onScroll={event => { scrollOffset.current = event.nativeEvent.contentOffset.y; }}
      ref={scroll}
      scrollEventThrottle={16}>
      <Text style={styles.eyebrow}>MICROSCOPY LEARNING</Text>
      <Text accessibilityRole="header" style={styles.title}>ScopePilot</Text>
      <Text style={styles.intro}>Take a closer look.</Text>
      <Text style={styles.body}>Choose a microscopy photo to explore its visible structures.</Text>
      <HealthDiagnostic />
      <View style={styles.preview}>
        {image ? <Image source={{ uri: image.uri }} style={styles.image} resizeMode="contain" accessibilityLabel="Selected microscopy image" />
          : <View style={styles.empty}><Text style={styles.sectionTitle}>Your specimen, up close</Text><Text style={styles.hint}>Select an image from your gallery to begin.</Text></View>}
      </View>
      <Pressable accessibilityRole="button" disabled={unavailable} onPress={pick}
        style={({ pressed }) => [styles.button, styles.secondary, (pressed || unavailable) && styles.dim]}>
        <Text style={styles.secondaryText}>{image ? 'Choose another image' : 'Choose from gallery'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !image || unavailable }}
        disabled={!image || unavailable} onPress={analyze}
        style={({ pressed }) => [styles.button, styles.primary, (!image || unavailable || pressed) && styles.dim]}>
        <Text style={styles.primaryText}>{stage === 'analyzing' ? 'Analyzing…' : 'Analyze image'}</Text>
      </Pressable>
      {stage !== 'idle' && <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color="#14685c" /><Text style={styles.body}>{stage === 'analyzing' ? 'Examining your image. This may take a minute.' : 'Preparing your image…'}</Text></View>}
      {error && <View accessibilityRole="alert" style={styles.error}><Text style={styles.errorText}>{error}</Text></View>}
      {result && <View accessibilityLiveRegion="polite" style={styles.results}>
        <Text accessibilityRole="header" style={styles.resultHeading}>Your observations</Text>
        <Section title="Probable Specimen" content={result.probable_specimen} />
        <Section title="Visible Structures" content={result.visible_structures} />
        <Section title="Observations" content={result.observations} />
        <Section title="Explanation" content={result.explanation} />
        <Section title="Limitations" content={result.limitations} />
        <View style={styles.followUp}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>Ask a follow-up question</Text>
          <Text style={styles.hint}>Ask about the current analysis. The answer will use it as tentative context.</Text>
          <View ref={questionContainer} style={styles.questionControls}>
            <TextInput
              accessibilityLabel="Follow-up question"
              editable={!isAsking}
              multiline
              onChangeText={setQuestion}
              onFocus={() => requestAnimationFrame(() => scrollQuestionIntoView())}
              placeholder="Why might this structure be visible?"
              style={styles.questionInput}
              value={question}
            />
            <Pressable accessibilityRole="button"
              accessibilityState={{ disabled: isAsking || !question.trim() }}
              disabled={isAsking || !question.trim()} onPress={ask}
              style={({ pressed }) => [styles.button, styles.primary, (isAsking || !question.trim() || pressed) && styles.dim]}>
              <Text style={styles.primaryText}>{isAsking ? 'Answering…' : 'Ask'}</Text>
            </Pressable>
          </View>
          {isAsking && <View accessibilityLiveRegion="polite" style={styles.loading}>
            <ActivityIndicator color="#14685c" /><Text style={styles.body}>Preparing an educational answer…</Text>
          </View>}
          {askError && <View accessibilityRole="alert" style={styles.error}><Text style={styles.errorText}>{askError}</Text></View>}
          {answer && <View accessibilityLiveRegion="polite" style={styles.answer}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Answer</Text>
            <Text style={styles.body}>{answer}</Text>
          </View>}
        </View>
        <View style={styles.quizPanel}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>Test your understanding</Text>
          {!quiz && <Pressable accessibilityRole="button" disabled={quizLoading || unavailable} onPress={startQuiz}
            style={({ pressed }) => [styles.button, styles.primary, (quizLoading || unavailable || pressed) && styles.dim]}>
            <Text style={styles.primaryText}>{quizLoading ? 'Preparing quiz…' : 'Test My Understanding'}</Text>
          </Pressable>}
          {quizError && <View accessibilityRole="alert" style={styles.error}><Text style={styles.errorText}>{quizError}</Text></View>}
          {quiz && (() => {
            const current = quiz.questions[currentQuestionIndex];
            const answeredCorrectly = selectedAnswer === current.correct_answer;
            return <View style={styles.quizContent}>
              <Text style={styles.hint}>Question {currentQuestionIndex + 1} of {quiz.questions.length}</Text>
              <Text style={styles.quizQuestion}>{current.question}</Text>
              <View style={styles.options}>
                {current.options.map(option => {
                  const selected = selectedAnswer === option;
                  const correct = answeredCurrentQuestion && option === current.correct_answer;
                  const selectedWrong = answeredCurrentQuestion && selected && !correct;
                  return <Pressable key={option} accessibilityRole="button"
                    accessibilityState={{ disabled: answeredCurrentQuestion, selected }}
                    disabled={answeredCurrentQuestion} onPress={() => selectAnswer(option)}
                    style={({ pressed }) => [styles.option, correct && styles.optionCorrect,
                      selectedWrong && styles.optionWrong, pressed && styles.optionPressed]}>
                    <Text style={[styles.optionText, selectedWrong && styles.optionWrongText]}>{option}</Text>
                  </Pressable>;
                })}
              </View>
              {answeredCurrentQuestion && <View style={styles.feedback}>
                <Text style={styles.sectionTitle}>{answeredCorrectly ? 'Correct' : 'Not quite'}</Text>
                {!answeredCorrectly && <Text style={styles.body}>Correct answer: {current.correct_answer}</Text>}
                <Text style={styles.body}>{current.explanation}</Text>
                {currentQuestionIndex < quiz.questions.length - 1
                  ? <Pressable accessibilityRole="button" onPress={nextQuestion} style={[styles.button, styles.primary]}>
                    <Text style={styles.primaryText}>Next Question</Text>
                  </Pressable>
                  : <Text style={styles.score}>Score: {score}/3</Text>}
              </View>}
              <Pressable accessibilityRole="button" onPress={clearQuiz} style={[styles.button, styles.secondary]}>
                <Text style={styles.secondaryText}>Close Quiz</Text>
              </Pressable>
            </View>;
          })()}
        </View>
      </View>}
      <Text style={styles.note}>For biology education. AI observations are tentative and need verification with your instructor. Not a medical diagnosis.</Text>
    </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f7f3' },
  flex: { flex: 1 },
  page: { padding: 24, gap: 12, width: '100%', maxWidth: 680, alignSelf: 'center', paddingBottom: 40 },
  eyebrow: { color: '#14685c', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginTop: 12 },
  title: { fontSize: 36, fontWeight: '800', color: '#173c35' },
  intro: { fontSize: 22, fontWeight: '600', color: '#173c35', marginTop: 8 },
  body: { fontSize: 16, lineHeight: 24, color: '#40554f' },
  preview: { backgroundColor: '#e7eee8', borderRadius: 18, overflow: 'hidden', marginVertical: 10 },
  image: { width: '100%', height: 280 },
  empty: { minHeight: 220, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  hint: { color: '#596d65', textAlign: 'center', lineHeight: 22 },
  button: { borderRadius: 12, padding: 16, alignItems: 'center', minHeight: 52 },
  primary: { backgroundColor: '#14685c' }, primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondary: { borderWidth: 1, borderColor: '#14685c' }, secondaryText: { color: '#14685c', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.5 }, loading: { flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap', paddingVertical: 8 },
  error: { padding: 16, backgroundColor: '#fcebe6', borderRadius: 12 }, errorText: { color: '#8a3220', lineHeight: 22 },
  results: { gap: 12, marginTop: 20 }, resultHeading: { fontSize: 24, fontWeight: '700', color: '#173c35' },
  section: { backgroundColor: '#fff', borderRadius: 14, padding: 18, gap: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: '#173c35' },
  followUp: { backgroundColor: '#e7eee8', borderRadius: 14, padding: 18, gap: 12 },
  quizPanel: { backgroundColor: '#e7eee8', borderRadius: 14, padding: 18, gap: 12 },
  quizContent: { gap: 12 },
  quizQuestion: { color: '#173c35', fontSize: 19, fontWeight: '700', lineHeight: 27 },
  options: { gap: 10 },
  option: { backgroundColor: '#fff', borderColor: '#a9bbb3', borderRadius: 10, borderWidth: 1, padding: 14 },
  optionCorrect: { borderColor: '#14685c', backgroundColor: '#d7eee4' },
  optionWrong: { borderColor: '#c9362b', backgroundColor: '#fde2e1' },
  optionPressed: { opacity: 0.75 },
  optionText: { color: '#173c35', fontSize: 16, lineHeight: 22 },
  optionWrongText: { color: '#8a1c14' },
  feedback: { backgroundColor: '#fff', borderRadius: 12, gap: 8, padding: 16 },
  score: { color: '#14685c', fontSize: 22, fontWeight: '800', textAlign: 'center' },
  questionControls: { gap: 12 },
  questionInput: { backgroundColor: '#fff', borderColor: '#a9bbb3', borderRadius: 10, borderWidth: 1, color: '#173c35', fontSize: 16, minHeight: 96, padding: 14, textAlignVertical: 'top' },
  answer: { backgroundColor: '#fff', borderRadius: 12, gap: 8, padding: 16 },
  note: { color: '#60716a', fontSize: 13, lineHeight: 20, marginTop: 16 },
});
