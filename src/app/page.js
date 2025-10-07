"use client";


import React, { useEffect, useMemo, useState } from "react";
import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase, ref, set, onValue, get, update, push } from "firebase/database";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  Download, Play, Square, Users, ChevronRight, ChevronLeft,
  Sparkles, PauseCircle, TimerReset, Clock3
} from "lucide-react";
/* =========================
   Firebase (correct config)
   ========================= */
// Firebase (env-based, client-safe)
const FIREBASE_CONFIG = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  databaseURL:
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ||
    (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
      ? `https://${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}-default-rtdb.europe-west1.firebasedatabase.app`
      : undefined),
};

const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);

// Anna URL eksplisiittisesti, niin SDK ei “arvaa”
const DB_URL =
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ||
  (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
    ? `https://${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}-default-rtdb.europe-west1.firebasedatabase.app`
    : undefined);

export const db = getDatabase(app, DB_URL);

/* ==============
   Small helpers
   ============== */
const makeRoomCode = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const clean = (s) => (s || "").trim();
const toCSV = (rows) =>
  rows.map(r => r.map(c => `"${String(c ?? "").replaceAll('"','""')}"`).join(",")).join("\n");

/* -----------------------------------------
   Server clock hook (fixes clock drift)
   ----------------------------------------- */
function useServerClock() {
  const [offset, setOffset] = useState(0); // ms
  useEffect(() => {
    const offRef = ref(db, ".info/serverTimeOffset");
    return onValue(offRef, snap => setOffset(snap.val() || 0));
  }, []);
  return () => Date.now() + offset; // serverNow()
}

/* ======================
   Sample questions JSON
   ====================== */
const SAMPLE_QUESTIONS_JSON = `[
  {"type":"mc","prompt":"What is the capital of Finland?","choices":["Helsinki","Tampere","Turku","Oulu"],"correctAnswer":0},
  {"type":"text","prompt":"Name any prime number between 40 and 50.","correctAnswer":"43"},
  {"type":"mc","prompt":"Which year did the first iPhone launch?","choices":["2005","2007","2009","2010"],"correctAnswer":1},
  {"type":"text","prompt":"Who painted the Mona Lisa?","correctAnswer":"Leonardo da Vinci"},
  {"type":"mc","prompt":"Which planet is known as the Red Planet?","choices":["Venus","Mars","Jupiter","Mercury"],"correctAnswer":1},
  {"type":"text","prompt":"What is 12×12?","correctAnswer":"144"},
  {"type":"mc","prompt":"Which language is primarily spoken in Brazil?","choices":["Spanish","Portuguese","French","English"],"correctAnswer":1},
  {"type":"text","prompt":"What is the chemical symbol for Gold?","correctAnswer":"Au"},
  {"type":"mc","prompt":"Which ocean is the largest?","choices":["Atlantic","Pacific","Indian","Arctic"],"correctAnswer":1},
  {"type":"text","prompt":"How many minutes in 3 hours?","correctAnswer":"180"},
  {"type":"mc","prompt":"Which city hosted the 2012 Summer Olympics?","choices":["Beijing","Rio de Janeiro","London","Tokyo"],"correctAnswer":2},
  {"type":"text","prompt":"What is the square root of 169?","correctAnswer":"13"}
]`;

/* =====================
   Realtime data hooks
   ===================== */
function useRoom(roomCode) {
  const [quiz, setQuiz] = useState(null);
  useEffect(() => {
    if (!roomCode) return;
    const quizRef = ref(db, `rooms/${roomCode}/quiz`);
    return onValue(quizRef, (snap) => setQuiz(snap.val() || null));
  }, [roomCode]);
  return quiz;
}

function useAnswers(roomCode, qIndex) {
  const [answers, setAnswers] = useState([]);
  useEffect(() => {
    if (!roomCode || qIndex == null || qIndex < 0) return;
    const aRef = ref(db, `rooms/${roomCode}/answers/${qIndex}`);
    return onValue(aRef, snap => {
      const val = snap.val() || {};
      setAnswers(Object.values(val));
    });
  }, [roomCode, qIndex]);
  return answers;
}

function useAllAnswers(roomCode) {
  const [all, setAll] = useState({});
  useEffect(() => {
    if (!roomCode) return;
    const base = ref(db, `rooms/${roomCode}/answers`);
    return onValue(base, snap => setAll(snap.val() || {}));
  }, [roomCode]);
  return all;
}

function useTick(ms = 250) {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(t => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/* ======================
   Quiz data operations
   ====================== */
async function createRoom({ title, questions }) {
  const code = makeRoomCode();
  const baseRef = ref(db, `rooms/${code}`);
  const quiz = {
    title: clean(title) || "Pub Quiz",
    questions: questions || [],
    currentIndex: -1,
    state: "lobby",
    defaultTimerSec: 60,
    accepting: false,
    timerEndsAt: 0,
    createdAt: Date.now(),
  };
  await set(baseRef, { quiz });
  return code;
}

// nowFn defaults to local now but Host will pass serverNow()
async function setTimer(roomCode, seconds, nowFn = () => Date.now()) {
  const ends = nowFn() + seconds * 1000;
  await update(ref(db, `rooms/${roomCode}/quiz`), { timerEndsAt: ends, accepting: true });
}
async function stopTimer(roomCode) {
  await update(ref(db, `rooms/${roomCode}/quiz`), { accepting: false });
}

// break after every CHUNK questions (10 by default)
const CHUNK = 10;

async function advance(roomCode, dir = 1, nowFn = () => Date.now()) {
  const quizRef = ref(db, `rooms/${roomCode}/quiz`);
  const snap = await get(quizRef);
  if (!snap.exists()) return;

  const quiz  = snap.val();
  const total = quiz.questions?.length || 0;
  let nextIndex = quiz.currentIndex + dir;

  const startQuestion = (index) => update(quizRef, {
    currentIndex: index,
    state: "question",
    accepting: true,
    timerEndsAt: nowFn() + (quiz.defaultTimerSec || 60) * 1000,
  });

  // Lobby → first question
  if (quiz.state === "lobby") {
    if (total === 0) return;
    await startQuestion(0);
    return;
  }

  // While showing a question
  if (quiz.state === "question") {
    if (dir > 0) {
      // finished?
      if (nextIndex >= total) {
        await update(quizRef, { currentIndex: total - 1, state: "results", accepting: false, timerEndsAt: 0 });
        return;
      }
      // break after every CHUNK questions (10, 20, 30, …), but not after the last one
      if (nextIndex > 0 && nextIndex % CHUNK === 0 && nextIndex < total) {
        await update(quizRef, { currentIndex: nextIndex, state: "break", accepting: false, timerEndsAt: 0 });
        return;
      }
      await startQuestion(nextIndex);
      return;
    } else {
      // going backwards
      if (nextIndex < 0) {
        await update(quizRef, { currentIndex: -1, state: "lobby", accepting: false, timerEndsAt: 0 });
        return;
      }
      // stepping back into a break boundary (…, 9, 19, 29, …)
      if ((nextIndex + 1) % CHUNK === 0) {
        await update(quizRef, { currentIndex: nextIndex, state: "break", accepting: false, timerEndsAt: 0 });
        return;
      }
      await startQuestion(nextIndex);
      return;
    }
  }

  // On a break screen
  if (quiz.state === "break") {
    if (dir > 0) {
      // resume with the first question of the next block (we stored the boundary index)
      await startQuestion(quiz.currentIndex);
    } else {
      // go back to the last question of the previous block
      await startQuestion(quiz.currentIndex - 1);
    }
    return;
  }

  // From results → back to last question
  if (quiz.state === "results" && dir < 0) {
    await startQuestion(total - 1);
  }
}


async function submitAnswer(roomCode, qIndex, player, answer, accepting) {
  if (!accepting) return; // hard block if time is up
  const aRef = ref(db, `rooms/${roomCode}/answers/${qIndex}`);
  const entry = { name: clean(player.name), id: player.id, answer, ts: Date.now() };
  await push(aRef, entry);
}

/* ======================
   Scoring utilities
   ====================== */
function calcScores(quiz, allAnswers) {
  const players = new Map();
  const questions = quiz?.questions || [];
  Object.entries(allAnswers || {}).forEach(([qIdxStr, rows]) => {
    const qIdx = Number(qIdxStr);
    const q = questions[qIdx];
    const correct = q?.correctAnswer;
    const normCorrect = q?.type === "mc" ? String(correct) : clean(String(correct || "").toLowerCase());
    Object.values(rows).forEach((r) => {
      const key = r.id + "::" + r.name;
      if (!players.has(key)) players.set(key, { name: r.name, id: r.id, score: 0, answers: {} });
      const p = players.get(key); p.answers[qIdx] = r.answer;
      if (q?.type === "mc") {
        if (String(r.answer) === normCorrect) p.score += 1;
      } else if (q?.type === "text") {
        if (clean(String(r.answer || "").toLowerCase()) === normCorrect) p.score += 1;
      }
    });
  });
  return Array.from(players.values()).sort((a, b) => b.score - a.score);
}

/* ======================
   UI components
   ====================== */
function ExportCSVButton({ roomCode, quiz }) {
  const all = useAllAnswers(roomCode);
  const csv = useMemo(() => {
    const rows = [];
    const header = ["Player", "Score", ...((quiz?.questions || []).map((q, i) => `Q${i + 1}`))];
    const scores = calcScores(quiz, all);
    rows.push(header);
    scores.forEach(s =>
      rows.push([s.name, s.score, ...((quiz?.questions || []).map((_, i) => s.answers?.[i] ?? ""))])
    );
    return toCSV(rows);
  }, [all, quiz]);

  const download = () => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(quiz?.title || "pub-quiz").replaceAll(" ", "-")}-results.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return <Button onClick={download} className="gap-2"><Download className="h-4 w-4" /> Export CSV</Button>;
}

function HostView({ roomCode, quiz }) {
  const serverNow = useServerClock();
  const qIndex = quiz?.currentIndex ?? -1;
  const question = quiz?.questions?.[qIndex];
  const answers = useAnswers(roomCode, qIndex);
  const all = useAllAnswers(roomCode);
  const scores = useMemo(() => calcScores(quiz, all), [quiz, all]);
  useTick(250);

  const secsLeft = quiz?.timerEndsAt ? Math.max(0, Math.ceil((quiz.timerEndsAt - serverNow()) / 1000)) : 0;
  const timeLeft = secsLeft >= 60
    ? `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")}`
    : `${secsLeft}s`;
  const timedOut = quiz?.accepting === false || serverNow() >= (quiz?.timerEndsAt || 0);

  return (
    <div className="grid gap-4">
      <Card className="shadow-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-xl">
            Room <span className="font-mono tracking-widest">{roomCode}</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => advance(roomCode, -1, serverNow)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button onClick={() => advance(roomCode, +1, serverNow)} className="gap-2">
              {quiz?.state === "lobby"   && <Play className="h-4 w-4" />}
              {quiz?.state === "break"   && <Play className="h-4 w-4" />}
              {quiz?.state === "question"&& <ChevronRight className="h-4 w-4" />}
              {quiz?.state === "results" && <Square className="h-4 w-4" />}
              {quiz?.state === "lobby" ? "Start" : quiz?.state === "break" ? "Resume" : quiz?.state === "question" ? "Next" : "Back to Qs"}
            </Button>
            <ExportCSVButton roomCode={roomCode} quiz={quiz} />
          </div>
        </CardHeader>

        <CardContent>
          {quiz?.state === "lobby" && (
            <div className="text-center py-10">
              <h2 className="text-3xl font-bold mb-2">{quiz?.title || "Pub Quiz"}</h2>
              <p className="text-muted-foreground">Share the room code. Players join on their phones.</p>
            </div>
          )}

          {quiz?.state === "break" && (
            <div className="text-center py-16">
              <PauseCircle className="mx-auto h-14 w-14" />
              <h3 className="text-2xl font-semibold mt-4">Break time!</h3>
              <p className="text-muted-foreground">Press Resume when ready.</p>
            </div>
          )}

          {quiz?.state === "question" && question && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid gap-6">
              <div className="p-6 bg-muted/40 rounded-2xl">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-muted-foreground">Question {qIndex + 1} / {quiz?.questions?.length}</div>
                    <h3 className="text-3xl font-bold mt-2 leading-snug">{question.prompt}</h3>
                  </div>
                  <div className="text-right">
                    <div className={`text-2xl font-bold ${timedOut ? "opacity-60" : ""}`}>
                      <span className="inline-flex items-center gap-2"><Clock3 className="h-6 w-6" />{timeLeft}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{timedOut ? "Time up" : "Answering open"}</div>
                  </div>
                </div>
                {question.type === "mc" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
                    {question.choices?.map((c, i) => (
                      <div key={i} className="p-3 rounded-xl border bg-background">
                        <div className="text-sm text-muted-foreground">Option {String.fromCharCode(65 + i)}</div>
                        <div className="font-medium">{c}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-3">
                <div className="flex items-center gap-2"><Users className="h-4 w-4" /><span className="text-sm text-muted-foreground">Answers ({answers.length})</span></div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                  {answers.map((a, idx) => (
                  <div key={idx} className="text-center text-sm p-2 rounded-xl border">
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="text-muted-foreground truncate">
                      {question.type === "mc"
                        ? `Option ${String.fromCharCode(65 + Number(a.answer))}`
                        : String(a.answer)}
                    </div>
                  </div>
                ))}
                </div>
              </div>

              <div className="grid sm:grid-cols-[1fr_auto_auto_auto] gap-3 items-center">
                <div className="grid gap-1">
                  <label className="text-xs text-muted-foreground">Default timer (40–60s)</label>
                  <div className="flex items-center gap-3">
                    <Slider
                      min={40} max={60} step={5}
                      value={[quiz?.defaultTimerSec || 60]}
                      onValueChange={async ([v]) => {
                        await update(ref(db, `rooms/${roomCode}/quiz`), { defaultTimerSec: v });
                      }}
                    />
                    <div className="w-10 text-right text-sm">{quiz?.defaultTimerSec || 60}s</div>
                  </div>
                </div>
                <Button variant="outline" onClick={() => setTimer(roomCode, quiz?.defaultTimerSec || 60, serverNow)} className="gap-2">
                  <TimerReset className="h-4 w-4" /> Restart timer
                </Button>
                <Button variant={timedOut ? "secondary" : "destructive"} onClick={() => stopTimer(roomCode)}>
                  {timedOut ? "Closed" : "Close answers"}
                </Button>
                <Button onClick={() => advance(roomCode, +1, serverNow)} className="gap-2">
                  <ChevronRight className="h-4 w-4" /> Next question
                </Button>
              </div>
            </motion.div>
          )}

          {quiz?.state === "results" && (
  <div className="grid gap-6">
    <div className="flex items-center gap-2">
      <Sparkles className="h-5 w-5" />
      <h3 className="text-xl font-semibold">Results</h3>
    </div>

    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2 pr-3">Player</th>
            <th className="py-2 pr-3">Score</th>
            {quiz?.questions?.map((_, i) => (
              <th key={i} className="py-2 px-2">Q{i + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scores.map((s, i) => (
  <tr key={i} className="border-b">
    <td className="py-2 pr-3 font-medium">{s.name}</td>
    <td className="py-2 pr-3">{s.score}</td>

    {quiz?.questions?.map((q, qi) => {
      const ans = s.answers?.[qi];
      const isCorrect =
        q.type === "mc"
          ? Number(ans) === q.correctAnswer
          : String(ans ?? "").trim().toLowerCase() ===
            String(q.correctAnswer ?? "").trim().toLowerCase();

      return (
        <td
          key={qi}
          className={`py-2 px-2 whitespace-nowrap ${
            isCorrect ? "text-green-600 font-medium" : ""
          }`}
        >
          {q.type === "mc"
            ? ans != null
              ? `Option ${String.fromCharCode(65 + Number(ans))}`
              : "—"
            : ans ?? "—"}
        </td>
      );
    })}
  </tr>
))}

        </tbody>
      </table>
    </div>
  </div>
)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Questions</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <Tabs defaultValue="paste">
            <TabsList>
              <TabsTrigger value="paste">Paste JSON</TabsTrigger>
              <TabsTrigger value="builder">Quick Builder</TabsTrigger>
            </TabsList>
            <TabsContent value="paste" className="grid gap-3">
              <Textarea id="qs" className="min-h-[220px] font-mono" defaultValue={SAMPLE_QUESTIONS_JSON} />
              <div className="flex gap-2">
                <Button onClick={async () => {
                  const el = document.getElementById("qs");
                  try {
                    const parsed = JSON.parse(el.value);
                    await update(ref(db, `rooms/${roomCode}/quiz`), {
                      questions: parsed, currentIndex: -1, state: "lobby", accepting: false, timerEndsAt: 0
                    });
                    alert("Questions loaded! Start when ready.");
                  } catch (e) { alert("Invalid JSON: " + e.message); }
                }}>Load Questions</Button>
                <Button variant="outline" onClick={() => navigator.clipboard.writeText(SAMPLE_QUESTIONS_JSON)}>Copy Sample</Button>
              </div>
            </TabsContent>
            <TabsContent value="builder">
              <QuickBuilder roomCode={roomCode} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function QuickBuilder({ roomCode }) {
  const [prompt, setPrompt] = useState("");
  const [type, setType] = useState("mc");
  const [choices, setChoices] = useState(["", "", "", ""]);
  const [correctAnswer, setCorrectAnswer] = useState(0);
  const [built, setBuilt] = useState([]);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <label className="text-sm text-muted-foreground">Question</label>
        <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Type your question" />
      </div>

      <div className="flex items-center gap-3">
        <label className={`text-sm ${type === "mc" ? "font-semibold" : ""}`}>Multiple Choice</label>
        <Toggle pressed={type === "text"} onPressedChange={(v) => setType(v ? "text" : "mc")}>Use Text Answer</Toggle>
        <label className={`text-sm ${type === "text" ? "font-semibold" : ""}`}>Text</label>
      </div>

      {type === "mc" ? (
        <div className="grid sm:grid-cols-2 gap-3">
          {choices.map((c, i) => (
            <div key={i} className="grid gap-1">
              <label className="text-xs text-muted-foreground">Option {String.fromCharCode(65 + i)}</label>
              <Input value={c} onChange={(e) => setChoices(prev => prev.map((p, idx) => idx === i ? e.target.value : p))} />
            </div>
          ))}
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">Correct Option (0-3)</label>
            <Input type="number" min={0} max={3} value={correctAnswer} onChange={(e) => setCorrectAnswer(Number(e.target.value))} />
          </div>
        </div>
      ) : (
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground">Correct Answer (for auto-scoring)</label>
          <Input value={correctAnswer} onChange={(e) => setCorrectAnswer(e.target.value)} placeholder="e.g. Helsinki" />
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={() => {
          const q = type === "mc"
            ? { type, prompt: clean(prompt), choices: choices.map(clean), correctAnswer: Number(correctAnswer) }
            : { type, prompt: clean(prompt), correctAnswer: clean(String(correctAnswer)) };
          setBuilt(b => [...b, q]);
          setPrompt(""); setChoices(["", "", "", ""]); setCorrectAnswer(type === "mc" ? 0 : "");
        }}>Add Question</Button>
        <Button variant="outline" onClick={() => setBuilt([])}>Clear</Button>
        <Button variant="secondary" onClick={async () => {
          await update(ref(db, `rooms/${roomCode}/quiz`), {
            questions: built, currentIndex: -1, state: "lobby", accepting: false, timerEndsAt: 0
          });
          alert(`Loaded ${built.length} question(s)!`);
        }}>Load to Room</Button>
      </div>

      {!!built.length && (
        <div>
          <div className="text-sm text-muted-foreground mb-2">Preview ({built.length})</div>
          <ol className="list-decimal pl-5 grid gap-2">
            {built.map((q, i) => (
              <li key={i} className="p-2 rounded-xl border">
                <div className="font-medium">{q.prompt}</div>
                {q.type === "mc" && (
                  <ul className="list-disc pl-5 text-sm text-muted-foreground">
                    {q.choices.map((c, idx) => (<li key={idx}>{c}{idx === q.correctAnswer ? " (correct)" : ""}</li>))}
                  </ul>
                )}
                {q.type === "text" && (<div className="text-sm text-muted-foreground">Correct: {q.correctAnswer}</div>)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function PlayerView({ roomCode, player }) {
  const serverNow = useServerClock();
  const quiz = useRoom(roomCode);
  const qIndex = quiz?.currentIndex ?? -1;
  const q = qIndex >= 0 ? quiz?.questions?.[qIndex] : null;
  const [selected, setSelected] = useState(null);
  const [text, setText] = useState("");
  const [submittedFor, setSubmittedFor] = useState({});
  useTick(250);

  useEffect(() => { setSelected(null); setText(""); }, [qIndex]);

  const submit = async () => {
    const answer = q?.type === "mc" ? selected : text;
    if (answer == null || String(answer).length === 0) return alert("Please answer first");
    await submitAnswer(
      roomCode, qIndex, player, answer,
      quiz?.accepting !== false && serverNow() < (quiz?.timerEndsAt || 0)
    );
    setSubmittedFor(m => ({ ...m, [qIndex]: true }));
  };

  if (!quiz) return null;

  const secsLeft = quiz?.timerEndsAt ? Math.max(0, Math.ceil((quiz.timerEndsAt - serverNow()) / 1000)) : 0;
  const timeLeft = secsLeft >= 60
    ? `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")}`
    : `${secsLeft}s`;
  const timedOut = quiz?.accepting === false || serverNow() >= (quiz?.timerEndsAt || 0);

  return (
    <div className="grid gap-4">
      {quiz.state === "lobby" && (
        <Card className="text-center p-10">
          <h3 className="text-2xl font-semibold">Waiting for the host to start…</h3>
          <p className="text-muted-foreground">Room {roomCode} · Player {player.name}</p>
        </Card>
      )}

      {quiz.state === "break" && (
        <Card className="text-center p-10">
          <h3 className="text-2xl font-semibold">Break time 🧃</h3>
          <p className="text-muted-foreground">Stretch your legs. Back soon!</p>
        </Card>
      )}

      {quiz.state === "question" && q && (
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-muted-foreground">Question {qIndex + 1} / {quiz?.questions?.length}</div>
              <h3 className="text-xl font-semibold mt-1">{q.prompt}</h3>
            </div>
            <div className="text-right">
              <div className={`text-xl font-bold ${timedOut ? "opacity-60" : ""}`}>{timeLeft}</div>
              <div className="text-xs text-muted-foreground">{timedOut ? "Time up" : "Answering open"}</div>
            </div>
          </div>

          {q.type === "mc" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
              {q.choices?.map((c, i) => (
                <button
                  key={i}
                  disabled={timedOut}
                  onClick={() => setSelected(i)}
                  className={`p-3 rounded-xl border text-left ${selected === i ? "ring-2 ring-offset-2" : ""} ${timedOut ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <div className="text-xs text-muted-foreground">Option {String.fromCharCode(65 + i)}</div>
                  <div className="font-medium">{c}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-4">
              <Input disabled={timedOut} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your answer" />
            </div>
          )}

          <div className="mt-4">
            {submittedFor[qIndex] ? (
              <Button variant="secondary" disabled>Submitted ✓</Button>
            ) : (
              <Button onClick={submit} disabled={timedOut}>Submit</Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}


/* =========================
   Root app component
   ========================= */
export default function PubQuizApp() {
  const [mode, setMode] = useState(null); // 'host' | 'player'
  const [roomCode, setRoomCode] = useState("");
  const [hostTitle, setHostTitle] = useState("Friday Pub Quiz");
  const [playerName, setPlayerName] = useState("");
  const [playerId] = useState(() => Math.random().toString(36).slice(2));

  const quiz = useRoom(roomCode);

  const startRoom = async () => {
    try {
      const code = await createRoom({ title: hostTitle, questions: [] });
      setRoomCode(code);
      setMode("host");
    } catch (e) {
      console.error("Create room failed:", e);
      alert("Create room failed: " + (e?.message || e));
    }
  };

  const joinRoom = async () => {
    if (!roomCode || !playerName) return alert("Enter room code and your name");
    const quizRef = ref(db, `rooms/${roomCode}/quiz`);
    const exists = (await get(quizRef)).exists();
    if (!exists) return alert("Room not found");
    setMode("player");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30 p-4 md:p-8">
      <div className="mx-auto max-w-5xl grid gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">🍻 Pub Quiz</h1>
          <div className="text-sm text-muted-foreground">Live, simple, and free</div>
        </header>
        <Separator />

        {!mode && (
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle>Host a Quiz</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                <Input value={hostTitle} onChange={(e) => setHostTitle(e.target.value)} placeholder="Quiz title" />
                <Button onClick={startRoom} className="gap-2"><Play className="h-4 w-4" /> Create Room</Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Join as Player</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                <div className="grid gap-1">
                  <label className="text-xs text-muted-foreground">Room Code</label>
                  <Input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} placeholder="ABCDE" />
                </div>
                <div className="grid gap-1">
                  <label className="text-xs text-muted-foreground">Your Name</label>
                  <Input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="e.g. Alex" />
                </div>
                <Button onClick={joinRoom} className="gap-2"><Users className="h-4 w-4" /> Join Room</Button>
              </CardContent>
            </Card>
          </div>
        )}

        {mode === "host" && roomCode && quiz && <HostView roomCode={roomCode} quiz={quiz} />}
        {mode === "player" && roomCode && <PlayerView roomCode={roomCode} player={{ id: playerId, name: playerName }} />}

        {mode && (
          <footer className="text-xs text-muted-foreground text-center pt-6">
            Tip: The quiz auto-pauses after question 10 for a break. Use the timer control to give 40–60s per question.
          </footer>
        )}
      </div>
    </div>
  );
}
