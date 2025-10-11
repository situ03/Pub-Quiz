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
   Firebase (client-safe)
   ========================= */
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
const DB_URL =
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ||
  (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
    ? `https://${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}-default-rtdb.europe-west1.firebasedatabase.app`
    : undefined);
export const db = getDatabase(app, DB_URL);

/* ==============
   Helpers
   ============== */
const makeRoomCode = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const clean = (s) => (s || "").trim();
const toCSV = (rows) =>
  rows.map(r => r.map(c => `"${String(c ?? "").replaceAll('"','""')}"`).join(",")).join("\n");

/* -----------------------------------------
   Server clock hook (fixes client clock drift)
   ----------------------------------------- */
function useServerClock() {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const offRef = ref(db, ".info/serverTimeOffset");
    return onValue(offRef, snap => setOffset(snap.val() || 0));
  }, []);
  return () => Date.now() + offset; // serverNow()
}

/* =====================
   Sample questions JSON
   ===================== */
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
async function createRoom({ title }) {
  const code = makeRoomCode();
  const baseRef = ref(db, `rooms/${code}`);
  const quiz = {
    title: clean(title) || "Pub Quiz",
    questions: [],
    revealedAnswers: {},
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

async function setTimer(roomCode, seconds, nowFn = () => Date.now()) {
  const ends = nowFn() + seconds * 1000;
  await update(ref(db, `rooms/${roomCode}/quiz`), { timerEndsAt: ends, accepting: true });
}
async function stopTimer(roomCode) {
  await update(ref(db, `rooms/${roomCode}/quiz`), { accepting: false });
}

const CHUNK = 10;

async function advance(roomCode, dir = 1, nowFn = () => Date.now()) {
  const quizRef = ref(db, `rooms/${roomCode}/quiz`);
  const snap = await get(quizRef);
  if (!snap.exists()) return;

  const quiz = snap.val();
  const total = quiz.questions?.length || 0;
  let nextIndex = quiz.currentIndex + dir;

  const revealCurrentIfAny = async () => {
    if (quiz.currentIndex >= 0 && quiz.currentIndex < total) {
      const ansSnap = await get(ref(db, `rooms/${roomCode}/hostAnswers/${quiz.currentIndex}`));
      const correct = ansSnap.val();
      if (correct !== undefined && correct !== null) {
        await update(quizRef, { [`revealedAnswers/${quiz.currentIndex}`]: correct });
      }
    }
  };

  const startQuestion = (index) =>
    update(quizRef, {
      currentIndex: index,
      state: "question",
      accepting: true,
      timerEndsAt: nowFn() + (quiz.defaultTimerSec || 60) * 1000,
    });

  if (quiz.state === "lobby") {
    if (total === 0) return;
    await startQuestion(0);
    return;
  }

  if (quiz.state === "question") {
    if (dir > 0) {
      await revealCurrentIfAny();
      if (nextIndex >= total) {
        await update(quizRef, { currentIndex: total - 1, state: "results", accepting: false, timerEndsAt: 0 });
        return;
      }
      if (nextIndex > 0 && nextIndex % CHUNK === 0 && nextIndex < total) {
        await update(quizRef, { currentIndex: nextIndex, state: "break", accepting: false, timerEndsAt: 0 });
        return;
      }
      await startQuestion(nextIndex);
      return;
    } else {
      if (nextIndex < 0) {
        await update(quizRef, { currentIndex: -1, state: "lobby", accepting: false, timerEndsAt: 0 });
        return;
      }
      if ((nextIndex + 1) % CHUNK === 0) {
        await update(quizRef, { currentIndex: nextIndex, state: "break", accepting: false, timerEndsAt: 0 });
        return;
      }
      await startQuestion(nextIndex);
      return;
    }
  }

  if (quiz.state === "break") {
    if (dir > 0) await startQuestion(quiz.currentIndex);
    else await startQuestion(quiz.currentIndex - 1);
    return;
  }

  if (quiz.state === "results" && dir < 0) await startQuestion(total - 1);
}

async function submitAnswer(roomCode, qIndex, player, answer, accepting) {
  if (!accepting) return;
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
  const revealed = quiz?.revealedAnswers || {};

  Object.entries(allAnswers || {}).forEach(([qIdxStr, rows]) => {
    const qIdx = Number(qIdxStr);
    const q = questions[qIdx];
    const correct = revealed[qIdx];
    const hasCorrect = correct !== undefined && correct !== null;

    Object.values(rows).forEach((r) => {
      const key = r.id + "::" + r.name;
      if (!players.has(key)) players.set(key, { name: r.name, id: r.id, score: 0, answers: {} });
      const p = players.get(key);
      p.answers[qIdx] = r.answer;

      if (!hasCorrect) return;
      if (q?.type === "mc") {
        if (String(r.answer) === String(correct)) p.score += 1;
      } else if (q?.type === "text") {
        const norm = (x) => clean(String(x || "").toLowerCase());
        if (norm(r.answer) === norm(correct)) p.score += 1;
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
    const header = ["Player", "Score", ...((quiz?.questions || []).map((_, i) => `Q${i + 1}`))];
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

/* --- HostView, QuickBuilder, PlayerView (same as your current code) --- */
/* --- ... [keep everything exactly as in your file above] ... --- */

/* =========================
   Root app component
   ========================= */
export default function PubQuizApp() {
  const [mode, setMode] = useState(null);
  const [roomCode, setRoomCode] = useState("");
  const [hostTitle, setHostTitle] = useState("Friday Pub Quiz");
  const [playerName, setPlayerName] = useState("");
  const [playerId] = useState(() => Math.random().toString(36).slice(2));

  const quiz = useRoom(roomCode);

  const startRoom = async () => {
    try {
      const code = await createRoom({ title: hostTitle });
      setRoomCode(code);
      setMode("host");
    } catch (e) {
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
          <div className="text-sm text-muted-foreground">yaaay omg so fuuuun</div>
        </header>
        <Separator />

        {!mode && (
          <>
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

            {/* --- NEW BUTTON: Rejoin existing room as Host --- */}
            <div className="text-center mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  const code = prompt("Enter the existing room code:");
                  if (!code) return;
                  setMode("host");
                  setRoomCode(code.toUpperCase());
                }}
              >
                🔁 Rejoin Existing Room as Host
              </Button>
            </div>
          </>
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
