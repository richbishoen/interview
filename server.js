const express = require('express');
const app = express();
app.use(express.json({ limit: '10mb' }));

const STORED_KEY = process.env.GROQ_API_KEY || '';

async function groqCall(key, messages, maxTokens = 2048) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + key,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: maxTokens,
    }),
  });
  const data = await r.json();
  if (data.error) {
    const msg = data.error.message || '';
    const code = data.error.code || '';
    if (code.includes('rate_limit') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota')) throw new Error('API_QUOTA');
    if (code.includes('invalid_api_key') || msg.includes('Invalid API Key') || msg.includes('No API key')) throw new Error('API_INVALID');
    throw new Error(msg);
  }
  return data.choices[0].message.content;
}

function friendlyError(e) {
  if (e.message === 'API_QUOTA') return 'API 요청 한도에 도달했습니다. 잠시 후 다시 시도하거나 console.groq.com에서 한도를 확인해주세요.';
  if (e.message === 'API_INVALID') return 'API 키가 유효하지 않습니다. console.groq.com → API Keys에서 키를 확인해주세요.';
  return e.message;
}

// ──────────────────────────────────────────
// API: 공고 분석
// ──────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { jobPosting, companyInfo, apiKey } = req.body;
  const key = STORED_KEY || apiKey;
  if (!key) return res.status(400).json({ error: 'API 키가 필요합니다.' });

  const prompt = `당신은 10년 경력의 HR 전문가입니다. 아래 채용 공고와 회사 정보를 분석하여 실제 면접에서 나올 핵심 질문들을 추출해주세요.

[채용 공고]
${jobPosting}

[회사 정보]
${companyInfo || '별도 회사 정보 없음'}

반드시 아래 JSON 형식으로만 답변하세요 (마크다운 코드블록 없이, 순수 JSON):
{
  "position": "지원 직무명",
  "company": "회사명",
  "interviewerName": "김지훈",
  "department": "People팀",
  "questions": {
    "자기소개 및 지원동기": ["질문1", "질문2", "질문3"],
    "직무역량": ["질문1", "질문2", "질문3", "질문4"],
    "회사 이해도": ["질문1", "질문2"],
    "상황 대처": ["질문1", "질문2"],
    "인성 및 가치관": ["질문1", "질문2"]
  },
  "keywords": ["핵심키워드1", "핵심키워드2", "핵심키워드3", "핵심키워드4"],
  "companyValues": ["회사가치1", "회사가치2", "회사가치3"],
  "tips": ["준비 팁1", "준비 팁2", "준비 팁3"]
}`;

  try {
    const text = await groqCall(key, [{ role: 'user', content: prompt }], 2048);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: '분석 결과 파싱 실패' });
    res.json(JSON.parse(match[0]));
  } catch (e) {
    res.status(500).json({ error: friendlyError(e) });
  }
});

// ──────────────────────────────────────────
// API: 면접 대화
// ──────────────────────────────────────────
app.post('/api/interview', async (req, res) => {
  const { messages, systemPrompt, apiKey } = req.body;
  const key = STORED_KEY || apiKey;
  if (!key) return res.status(400).json({ error: 'API 키가 필요합니다.' });

  const groqMessages = [{ role: 'system', content: systemPrompt }, ...messages];

  try {
    const text = await groqCall(key, groqMessages, 600);
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e) });
  }
});

// ──────────────────────────────────────────
// API: 피드백 생성
// ──────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { conversation, analysisData, apiKey, frames } = req.body;
  const key = STORED_KEY || apiKey;
  if (!key) return res.status(400).json({ error: 'API 키가 필요합니다.' });

  const convText = conversation
    .map(m => `[${m.role === 'user' ? '지원자' : '면접관'}]: ${m.content}`)
    .join('\n\n');

  // 텍스트 피드백
  const textPrompt = `아래는 ${analysisData.company} ${analysisData.position} 포지션 모의 면접 전체 대화록입니다.

[면접 대화록]
${convText}

지원자의 답변을 전문 HR 컨설턴트 입장에서 종합 평가해주세요. 반드시 아래 JSON 형식으로만 답변하세요 (순수 JSON):
{
  "overallScore": 75,
  "grade": "B+",
  "summary": "전반적인 한 줄 평가 (2문장)",
  "strengths": ["잘한 점1", "잘한 점2", "잘한 점3"],
  "improvements": ["개선점1", "개선점2", "개선점3"],
  "questionFeedback": [
    {
      "question": "면접관이 한 질문 (원문 그대로)",
      "rating": 4,
      "feedback": "이 답변에 대한 구체적 피드백 (2-3문장)",
      "betterAnswer": "더 효과적인 답변 예시 (2-3문장)"
    }
  ],
  "finalAdvice": "합격 가능성을 높이기 위한 최종 조언 (3-4문장)"
}`;

  try {
    // 1) 텍스트 피드백
    const text = await groqCall(key, [{ role: 'user', content: textPrompt }], 3000);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: '피드백 파싱 실패' });
    const result = JSON.parse(match[0]);

    // 화상 분석: Groq는 Vision 미지원 — 웹캠 프레임 분석 비활성화

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: friendlyError(e) });
  }
});

// ──────────────────────────────────────────
// HTML 앱 서빙
// ──────────────────────────────────────────
app.get('/', (req, res) => res.send(HTML));

// ──────────────────────────────────────────
// 서버 시작
// ──────────────────────────────────────────
const PORT = process.env.PORT || 3737;
app.listen(PORT, () => {
  console.log('\n┌─────────────────────────────────────────┐');
  console.log('│       🎤  AI 면접 연습 앱 시작됨         │');
  console.log('├─────────────────────────────────────────┤');
  console.log('│  브라우저: http://localhost:' + PORT + '         │');
  console.log('│  종료: Ctrl+C                            │');
  console.log('└─────────────────────────────────────────┘\n');
});

// ──────────────────────────────────────────
// 프론트엔드 HTML (React + Tailwind CDN)
// ──────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AI 면접 연습</title>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Inter', -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; background: #f2f0eb; }
  .glass {
    background: rgba(255,255,255,0.72);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255,255,255,0.65);
    box-shadow: 0 2px 20px rgba(0,0,0,0.055), 0 1px 3px rgba(0,0,0,0.04);
  }
  .glass-dark {
    background: rgba(26,26,26,0.94);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .chat-scroll { scroll-behavior: smooth; }
  @keyframes pulse-dot { 0%,80%,100%{transform:scale(0)} 40%{transform:scale(1)} }
  .dot { animation: pulse-dot 1.4s infinite ease-in-out both; }
  .dot:nth-child(1){animation-delay:-0.32s} .dot:nth-child(2){animation-delay:-0.16s}
  textarea, input { outline: none; }
  textarea { resize: none; }
  .fade-in { animation: fadeIn 0.25s ease; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 4px; }
  ::placeholder { color: #b0aca4; }
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useRef, useCallback } = React;

// ── 아이콘 컴포넌트 ──
const Icon = ({ d, size = 20, color = 'currentColor', className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d={d} />
  </svg>
);

const ICONS = {
  mic: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8',
  send: 'M22 2L11 13M22 2L15 22 11 13 2 9l20-7z',
  check: 'M20 6L9 17l-5-5',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  chevron: 'M9 18l6-6-6-6',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22',
  refresh: 'M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15',
  building: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',
  award: 'M12 15c4.97 0 9-3.58 9-8s-4.03-8-9-8-9 3.58-9 8 4.03 8 9 8zM8.21 13.89L7 23l5-3 5 3-1.21-9.12',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
};

// ── 로딩 도트 ──
const LoadingDots = () => (
  <div className="flex gap-1 items-center px-4 py-3">
    {[0,1,2].map(i => (
      <span key={i} className="dot w-2 h-2 bg-gray-400 rounded-full block" style={{animationDelay: \`\${i*-0.16}s\`}} />
    ))}
  </div>
);

// ── 점수 게이지 ──
const ScoreGauge = ({ score }) => {
  const r = 54, c = 2 * Math.PI * r;
  const offset = c - (score / 100) * c;
  const color = score >= 80 ? '#16a34a' : score >= 60 ? '#1c1c1e' : '#ea580c';
  return (
    <div className="relative flex items-center justify-center" style={{width:140,height:140}}>
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10"/>
        <circle cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={c} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 70 70)"
          style={{transition:'stroke-dashoffset 1s ease'}}/>
      </svg>
      <div className="absolute text-center">
        <div className="text-3xl font-bold" style={{color}}>{score}</div>
        <div className="text-xs text-gray-500">/ 100</div>
      </div>
    </div>
  );
};

// ── 별점 ──
const Stars = ({ rating }) => (
  <div className="flex gap-0.5">
    {[1,2,3,4,5].map(i => (
      <svg key={i} width="14" height="14" viewBox="0 0 24 24" fill={i<=rating?'#f59e0b':'#e2e8f0'} stroke={i<=rating?'#f59e0b':'#e2e8f0'} strokeWidth="1">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>
    ))}
  </div>
);

// ── 메인 앱 ──
function App() {
  const [screen, setScreen] = useState('setup');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('iw_key') || '');
  const [showKey, setShowKey] = useState(false);
  const [jobPosting, setJobPosting] = useState('');
  const [companyInfo, setCompanyInfo] = useState('');
  const [interviewType, setInterviewType] = useState('직무면접');
  const [analysisData, setAnalysisData] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [feedbackData, setFeedbackData] = useState(null);
  const [error, setError] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [keyConnected, setKeyConnected] = useState(() => !!localStorage.getItem('iw_key'));
  const [keyExpanded, setKeyExpanded] = useState(() => !localStorage.getItem('iw_key'));
  const [openCategory, setOpenCategory] = useState(null);
  const [openFeedback, setOpenFeedback] = useState(null);
  // 음성/화상
  const [voiceMode, setVoiceMode] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [webcamOn, setWebcamOn] = useState(false);
  const [capturedFrames, setCapturedFrames] = useState([]);
  const chatEndRef = useRef(null);
  const videoRef = useRef(null);
  const recognitionRef = useRef(null);
  const captureTimerRef = useRef(null);

  const saveApiKey = () => {
    if (!apiKey.trim()) return;
    localStorage.setItem('iw_key', apiKey.trim());
    setKeySaved(true);
    setKeyConnected(true);
    setKeyExpanded(false);
    setTimeout(() => setKeySaved(false), 2000);
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // 면접관 메시지 자동 음성 출력
  useEffect(() => {
    if (!voiceMode || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'assistant') return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(last.content);
    utter.lang = 'ko-KR'; utter.rate = 1.0; utter.pitch = 1.05;
    utter.onstart = () => setIsSpeaking(true);
    utter.onend = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utter);
  }, [messages, voiceMode]);

  // 음성 인식
  const startListening = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setError('이 브라우저는 음성 인식을 지원하지 않습니다.'); return; }
    window.speechSynthesis.cancel();
    const rec = new SR();
    rec.lang = 'ko-KR'; rec.continuous = false; rec.interimResults = false;
    rec.onstart = () => setIsListening(true);
    rec.onresult = e => { setInputText(e.results[0][0].transcript); setIsListening(false); };
    rec.onerror = () => setIsListening(false);
    rec.onend = () => setIsListening(false);
    recognitionRef.current = rec;
    rec.start();
  };
  const stopListening = () => { recognitionRef.current?.stop(); setIsListening(false); };

  // 웹캠
  const toggleWebcam = async () => {
    if (webcamOn) {
      const stream = videoRef.current?.srcObject;
      stream?.getTracks().forEach(t => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      clearInterval(captureTimerRef.current);
      setWebcamOn(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
        setWebcamOn(true);
        // 30초마다 프레임 캡처
        captureTimerRef.current = setInterval(() => {
          if (!videoRef.current) return;
          const c = document.createElement('canvas'); c.width = 320; c.height = 240;
          c.getContext('2d').drawImage(videoRef.current, 0, 0, 320, 240);
          setCapturedFrames(prev => [...prev.slice(-4), c.toDataURL('image/jpeg', 0.6).split(',')[1]]);
        }, 30000);
      } catch(e) { setError('카메라 접근 권한이 필요합니다.'); }
    }
  };

  // 면접 종료 시 웹캠 정리
  const cleanupWebcam = () => {
    const stream = videoRef.current?.srcObject;
    stream?.getTracks().forEach(t => t.stop());
    clearInterval(captureTimerRef.current);
    setWebcamOn(false);
  };

  // 공고 분석
  const handleAnalyze = async () => {
    if (!jobPosting.trim()) { setError('채용 공고를 입력해주세요.'); return; }
    if (!apiKey.trim()) { setError('Groq API 키를 입력해주세요.'); return; }
    setError('');
    setScreen('analyzing');
    try {
      const r = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobPosting, companyInfo, apiKey }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setAnalysisData(data);
      setScreen('briefing');
    } catch (e) {
      setError(e.message);
      setScreen('setup');
    }
  };

  // 면접 시작
  const handleStartInterview = () => {
    setMessages([]);
    setScreen('interview');
    startInterview();
  };

  const buildSystemPrompt = (data) => \`당신은 \${data.company}의 채용 담당 \${data.interviewerName} \${data.department} 소속 면접관입니다.
지원자는 \${data.position} 포지션에 지원했으며, 오늘 \${interviewType}을 진행합니다.

[면접 진행 방식]
- 한 번에 반드시 하나의 질문만 합니다
- 지원자 답변 후 자연스럽게 후속 질문이나 다음 질문으로 넘어갑니다
- 편안하면서도 적당히 전문적인 분위기를 유지합니다
- 답변이 모호하면 "조금 더 구체적으로 말씀해주실 수 있을까요?"처럼 파고듭니다
- 답변이 좋으면 "네, 좋습니다." 수준의 짧은 호응 후 다음으로 넘어갑니다
- 면접관 이름을 밝히고 시작하세요
- 총 8~12개 질문 후 면접을 자연스럽게 마무리하세요
- 마무리 시 "오늘 면접은 여기까지입니다. 수고하셨습니다." 로 끝내세요

[핵심 키워드 (답변에서 확인할 것)]
\${data.keywords.join(', ')}

[회사 가치관]
\${data.companyValues.join(', ')}

반드시 한국어로, 격식 있되 딱딱하지 않게 대화하세요.\`;

  const startInterview = async () => {
    setIsLoading(true);
    try {
      const system = buildSystemPrompt(analysisData);
      const r = await fetch('/api/interview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '면접을 시작해주세요.' }],
          systemPrompt: system,
          apiKey,
        }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setMessages([{ role: 'assistant', content: data.text }]);
    } catch (e) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  // 답변 전송
  const handleSend = async () => {
    if (!inputText.trim() || isLoading) return;
    const userMsg = { role: 'user', content: inputText.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInputText('');
    setIsLoading(true);

    try {
      const system = buildSystemPrompt(analysisData);
      // assistant 메시지를 올바른 형식으로 변환
      const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }));
      const r = await fetch('/api/interview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, systemPrompt: system, apiKey }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setMessages(prev => [...prev, { role: 'assistant', content: data.text }]);
    } catch (e) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  // 면접 종료 → 피드백
  const handleEndInterview = async () => {
    window.speechSynthesis.cancel();
    // 마지막 프레임 캡처
    if (webcamOn && videoRef.current) {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      c.getContext('2d').drawImage(videoRef.current, 0, 0, 320, 240);
      const last = c.toDataURL('image/jpeg', 0.6).split(',')[1];
      setCapturedFrames(prev => [...prev.slice(-4), last]);
    }
    cleanupWebcam();
    setScreen('analyzing');
    try {
      const frames = capturedFrames.length > 0 ? capturedFrames : null;
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversation: messages, analysisData, apiKey, frames }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setFeedbackData(data);
      setScreen('feedback');
    } catch (e) {
      setError(e.message);
      setScreen('interview');
    }
  };

  const handleReset = () => {
    setScreen('setup');
    setMessages([]);
    setAnalysisData(null);
    setFeedbackData(null);
    setJobPosting('');
    setCompanyInfo('');
    setError('');
  };

  // ── 화면 렌더링 ──

  if (screen === 'analyzing') return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#f2f0eb]">
      <div className="text-center fade-in">
        <div className="w-16 h-16 mx-auto mb-6 relative">
          <div className="w-16 h-16 rounded-full border-4 border-gray-100 border-t-gray-800 animate-spin"/>
        </div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">AI가 공고를 분석하고 있습니다</h2>
        <p className="text-gray-500 text-sm">핵심 질문을 추출하고 면접관을 준비하는 중...</p>
      </div>
    </div>
  );

  if (screen === 'setup') {
    const canStart = jobPosting.trim() && apiKey.trim();
    const btnHint = !apiKey.trim() ? 'API 키를 먼저 저장해주세요' : !jobPosting.trim() ? '채용 공고를 입력해주세요' : '';
    return (
    <div className="min-h-screen bg-white">
      {/* 헤더 */}
      <div className="glass sticky top-0 z-10 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-gray-900 rounded-lg flex items-center justify-center">
            <Icon d={ICONS.mic} size={14} color="white"/>
          </div>
          <span className="font-bold text-gray-900">InterviewAI</span>
          <span className="text-xs bg-stone-100 text-gray-900 px-2 py-0.5 rounded-full font-medium">Beta</span>
        </div>
        {/* API 키 연결 상태 */}
        {keyConnected && !keyExpanded ? (
          <button onClick={() => setKeyExpanded(true)} className="flex items-center gap-1.5 text-xs bg-green-50 text-green-700 border border-green-200 px-3 py-1.5 rounded-full hover:bg-green-100 transition-colors font-medium">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="#16a34a"><circle cx="5" cy="5" r="5"/></svg>
            API 연결됨 · 변경
          </button>
        ) : (
          <span className="text-xs text-gray-400">API 키 미설정</span>
        )}
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8">

        {/* 히어로 */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">AI 면접 연습</h1>
          <p className="text-gray-400 text-sm">공고를 붙여넣으면 실제 면접관처럼 질문하고 상세한 피드백까지</p>
        </div>

        {/* 스텝 인디케이터 */}
        <div className="flex items-center justify-center gap-0 mb-8">
          {[['1', '공고 입력'], ['2', 'AI 분석'], ['3', '면접 시작']].map(([n, label], i) => (
            <React.Fragment key={n}>
              <div className="flex items-center gap-2">
                <div className={\`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold \${i === 0 ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-400'}\`}>{n}</div>
                <span className={\`text-xs font-medium \${i === 0 ? 'text-gray-900' : 'text-gray-400'}\`}>{label}</span>
              </div>
              {i < 2 && <div className="w-10 h-px bg-gray-200 mx-2"/>}
            </React.Fragment>
          ))}
        </div>

        {/* API 키 (접힌 상태면 숨김) */}
        {keyExpanded && (
          <div className="bg-gray-50 rounded-2xl border border-gray-200 p-4 mb-5 fade-in">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Icon d={ICONS.zap} size={14} color="#4f46e5"/>
                <span className="text-sm font-semibold text-gray-700">Groq API 키</span>
                <span className="text-xs text-gray-400">console.groq.com → API Keys · 무료</span>
              </div>
              {keyConnected && <button onClick={() => setKeyExpanded(false)} className="text-xs text-gray-400 hover:text-gray-600">닫기</button>}
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => { setApiKey(e.target.value); setKeyConnected(false); }}
                  onKeyDown={e => e.key === 'Enter' && saveApiKey()}
                  placeholder="AIzaSy..."
                  className="w-full border border-gray-200 bg-white rounded-xl px-4 py-2.5 text-sm font-mono pr-10 focus:outline-none focus:ring-2 focus:ring-gray-300"
                />
                <button onClick={() => setShowKey(!showKey)} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
                  <Icon d={showKey ? ICONS.eyeOff : ICONS.eye} size={16}/>
                </button>
              </div>
              <button
                onClick={saveApiKey}
                disabled={!apiKey.trim()}
                className={\`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all shrink-0 \${keySaved ? 'bg-green-500 text-white' : 'bg-gray-900 hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400 text-white'}\`}
              >
                {keySaved ? '✓ 저장됨' : '저장'}
              </button>
            </div>
          </div>
        )}

        {/* 채용 공고 (메인) */}
        <div className={\`rounded-2xl border-2 transition-colors mb-4 \${jobPosting ? 'border-indigo-200 bg-white' : 'border-dashed border-gray-200 bg-white'}\`}>
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <div className="flex items-center gap-2">
              <Icon d={ICONS.target} size={15} color="#4f46e5"/>
              <span className="text-sm font-semibold text-gray-800">채용 공고</span>
              <span className="text-xs text-red-400 font-medium">필수</span>
            </div>
            {jobPosting && <span className="text-xs text-gray-500 font-medium">✓ 입력됨</span>}
          </div>
          <textarea
            value={jobPosting}
            onChange={e => setJobPosting(e.target.value)}
            placeholder={"채용 공고 전문을 여기에 붙여넣어 주세요.\\n\\n직무명, 담당업무, 자격요건, 우대사항이 모두 포함될수록\\n실제 면접에 가까운 질문이 만들어집니다."}
            className="w-full h-56 px-5 pb-4 text-sm focus:outline-none text-gray-700 leading-relaxed bg-transparent"
          />
        </div>

        {/* 하단 행: 회사정보 + 면접유형 */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Icon d={ICONS.building} size={14} color="#6366f1"/>
              <span className="text-xs font-semibold text-gray-700">회사 정보</span>
              <span className="text-xs text-gray-400">선택</span>
            </div>
            <textarea
              value={companyInfo}
              onChange={e => setCompanyInfo(e.target.value)}
              placeholder={"회사 소개, 비전, 최근 뉴스 등\\n입력 시 질문 품질이 높아집니다."}
              className="w-full h-28 text-xs focus:outline-none text-gray-700 leading-relaxed"
            />
          </div>
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Icon d={ICONS.user} size={14} color="#4f46e5"/>
              <span className="text-xs font-semibold text-gray-700">면접 유형</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {['HR면접', '직무면접', '임원면접', '최종면접'].map(t => (
                <button
                  key={t}
                  onClick={() => setInterviewType(t)}
                  className={\`py-2 rounded-xl text-xs font-medium transition-all \${
                    interviewType === t
                      ? 'bg-gray-900 text-white shadow-sm'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200'
                  }\`}
                >{t}</button>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-100 text-red-700 rounded-xl px-4 py-3 text-sm mb-4 flex items-start gap-2">
            <span className="shrink-0 mt-0.5">⚠️</span>
            <div>
              <span>{error}</span>
              {(error.includes('한도') || error.includes('유효하지')) && (
                <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer"
                  className="block mt-1 text-xs underline text-red-600 font-medium">
                  → console.groq.com에서 새 키 발급하기
                </a>
              )}
            </div>
          </div>
        )}

        <button
          onClick={handleAnalyze}
          disabled={!canStart}
          className="w-full py-4 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-100 text-white disabled:text-gray-400 font-semibold rounded-2xl text-sm transition-all shadow-lg shadow-indigo-100 hover:shadow-black/10 disabled:shadow-none"
        >
          {canStart ? '면접 준비 시작하기 →' : btnHint}
        </button>
      </div>
    </div>
  );}

  if (screen === 'briefing' && analysisData) {
    const allQ = Object.entries(analysisData.questions || {});
    return (
      <div className="min-h-screen bg-[#f2f0eb]">
        {/* 헤더 */}
        <div className="border-b border-gray-100 bg-white/80 backdrop-blur px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-900 rounded-lg flex items-center justify-center">
              <Icon d={ICONS.mic} size={16} color="white"/>
            </div>
            <span className="font-bold text-gray-900">InterviewAI</span>
          </div>
          <button onClick={() => setScreen('setup')} className="text-sm text-gray-500 hover:text-gray-700">← 다시 입력</button>
        </div>

        <div className="max-w-5xl mx-auto px-6 py-8">
          {/* 분석 완료 배너 */}
          <div className="glass-dark rounded-2xl p-6 text-white mb-8 fade-in">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-gray-300 text-sm font-medium mb-1">분석 완료</div>
                <h2 className="text-2xl font-bold mb-1">{analysisData.company}</h2>
                <p className="text-gray-200">{analysisData.position} · {interviewType}</p>
              </div>
              <div className="text-right">
                <div className="text-gray-300 text-xs mb-1">면접관</div>
                <div className="font-semibold">{analysisData.interviewerName} 면접관</div>
                <div className="text-gray-300 text-sm">{analysisData.department}</div>
              </div>
            </div>
            {/* 키워드 */}
            <div className="mt-4 pt-4 border-t border-indigo-500 flex flex-wrap gap-2">
              {(analysisData.keywords || []).map(k => (
                <span key={k} className="bg-stone-1000/50 text-white text-xs px-3 py-1 rounded-full">{k}</span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            {/* 예상 질문 */}
            <div className="md:col-span-2 glass rounded-2xl p-6">
              <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                <Icon d={ICONS.target} size={18} color="#4f46e5"/>
                예상 핵심 질문
              </h3>
              <div className="space-y-2">
                {allQ.map(([category, qs]) => (
                  <div key={category} className="border border-gray-100 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setOpenCategory(openCategory === category ? null : category)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors text-left"
                    >
                      <span className="font-medium text-gray-800 text-sm">{category}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs bg-stone-100 text-gray-900 px-2 py-0.5 rounded-full">{qs.length}개</span>
                        <Icon d={ICONS.chevron} size={16} color="#9ca3af" className={\`transition-transform \${openCategory === category ? 'rotate-90' : ''}\`}/>
                      </div>
                    </button>
                    {openCategory === category && (
                      <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3 space-y-2">
                        {qs.map((q, i) => (
                          <div key={i} className="flex gap-2 text-sm text-gray-700">
                            <span className="text-gray-400 font-bold shrink-0">Q{i+1}.</span>
                            <span>{q}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* 준비 팁 + 회사 가치 */}
            <div className="space-y-5">
              <div className="glass rounded-2xl p-5">
                <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2 text-sm">
                  <Icon d={ICONS.award} size={16} color="#f59e0b"/>
                  회사 핵심 가치
                </h3>
                <div className="space-y-2">
                  {(analysisData.companyValues || []).map((v, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm text-gray-700">
                      <div className="w-1.5 h-1.5 rounded-full bg-indigo-400"/>
                      {v}
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-amber-50 rounded-2xl border border-amber-100 p-5">
                <h3 className="font-bold text-amber-800 mb-3 text-sm flex items-center gap-2">
                  <Icon d={ICONS.star} size={16} color="#d97706"/>
                  준비 팁
                </h3>
                <div className="space-y-2">
                  {(analysisData.tips || []).map((t, i) => (
                    <div key={i} className="text-sm text-amber-700 flex gap-2">
                      <span className="shrink-0">•</span>
                      <span>{t}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={handleStartInterview}
            className="w-full py-4 bg-gray-900 hover:bg-gray-800 text-white font-bold rounded-2xl text-lg transition-all shadow-lg shadow-black/10 hover:shadow-black/15"
          >
            면접 시작하기 →
          </button>
        </div>
      </div>
    );
  }

  if (screen === 'interview') return (
    <div className="h-screen flex flex-col bg-[#f2f0eb]">
      {/* 상단 바 */}
      <div className="glass px-5 py-3 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-gray-900 rounded-lg flex items-center justify-center">
            <Icon d={ICONS.mic} size={13} color="white"/>
          </div>
          <div>
            <div className="font-semibold text-gray-900 text-sm">{analysisData?.company} · {analysisData?.position}</div>
            <div className="text-xs text-gray-500">{interviewType} · {analysisData?.interviewerName} 면접관</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 음성 모드 토글 */}
          <button
            onClick={() => { setVoiceMode(v => !v); window.speechSynthesis.cancel(); }}
            className={\`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all \${voiceMode ? 'bg-gray-900 text-white' : 'bg-white/60 text-gray-600 border border-gray-200 hover:bg-white'}\`}
          >
            <Icon d={ICONS.mic} size={12}/> {voiceMode ? '음성 ON' : '음성'}
          </button>
          {/* 화상 토글 */}
          <button
            onClick={toggleWebcam}
            className={\`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all \${webcamOn ? 'bg-gray-900 text-white' : 'bg-white/60 text-gray-600 border border-gray-200 hover:bg-white'}\`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 7l-7 5 7 5V7zM1 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H1a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>
            {webcamOn ? '화상 ON' : '화상'}
          </button>
          <button onClick={handleEndInterview} className="px-4 py-1.5 bg-gray-900 hover:bg-gray-800 text-white text-xs font-medium rounded-xl transition-colors">
            종료 →
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {/* 웹캠 미리보기 (우하단 고정) */}
        {webcamOn && (
          <div className="absolute bottom-24 right-4 z-20 rounded-2xl overflow-hidden shadow-2xl border-2 border-white/50" style={{width:200,height:150}}>
            <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover"/>
            {isSpeaking && (
              <div className="absolute inset-0 flex items-end justify-center pb-2">
                <div className="bg-black/40 text-white text-xs px-2 py-0.5 rounded-full">면접관 말하는 중...</div>
              </div>
            )}
          </div>
        )}
        {/* 웹캠 (화상 OFF일 때도 ref 유지용 숨김 video) */}
        {!webcamOn && <video ref={videoRef} autoPlay muted playsInline className="hidden"/>}

        {/* 사이드바 */}
        <div className="w-56 flex flex-col overflow-y-auto shrink-0 hidden md:flex" style={{background:'rgba(255,255,255,0.45)', borderRight:'1px solid rgba(0,0,0,0.05)'}}>
          <div className="px-4 py-3" style={{borderBottom:'1px solid rgba(0,0,0,0.05)'}}>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">예상 질문</p>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {Object.entries(analysisData?.questions || {}).map(([cat, qs]) => (
              <div key={cat} className="mb-4">
                <p className="text-xs font-semibold text-gray-500 px-2 mb-1.5">{cat}</p>
                {qs.map((q, i) => (
                  <div key={i} className="text-xs text-gray-500 px-2 py-1.5 rounded-lg hover:bg-white/60 leading-relaxed mb-0.5 cursor-default transition-colors">{q}</div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* 채팅 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 chat-scroll">
            {messages.map((m, i) => (
              <div key={i} className={\`flex \${m.role === 'user' ? 'justify-end' : 'justify-start'} fade-in\`}>
                {m.role === 'assistant' && (
                  <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center mr-2 mt-1 shrink-0 shadow-sm border border-gray-100">
                    <Icon d={ICONS.user} size={14} color="#555"/>
                  </div>
                )}
                <div className={\`max-w-[72%]\`}>
                  {m.role === 'assistant' && (
                    <p className="text-xs text-gray-400 mb-1 ml-1">{analysisData?.interviewerName} 면접관</p>
                  )}
                  <div className={\`px-4 py-3 rounded-2xl text-sm leading-relaxed \${
                    m.role === 'user'
                      ? 'bg-gray-900 text-white rounded-tr-sm'
                      : 'bg-white/85 text-gray-800 shadow-sm rounded-tl-sm'
                  }\`} style={m.role==='assistant'?{backdropFilter:'blur(12px)',border:'1px solid rgba(255,255,255,0.7)'}:{}}>
                    {m.content}
                  </div>
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex items-start fade-in">
                <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center mr-2 shrink-0 shadow-sm border border-gray-100">
                  <Icon d={ICONS.user} size={14} color="#555"/>
                </div>
                <div className="bg-white/85 rounded-2xl rounded-tl-sm shadow-sm" style={{backdropFilter:'blur(12px)',border:'1px solid rgba(255,255,255,0.7)'}}>
                  <LoadingDots/>
                </div>
              </div>
            )}
            {isSpeaking && !webcamOn && (
              <div className="flex justify-center fade-in">
                <div className="bg-white/70 text-gray-500 text-xs px-3 py-1 rounded-full shadow-sm">면접관이 말하는 중...</div>
              </div>
            )}
            <div ref={chatEndRef}/>
          </div>

          {/* 입력 영역 */}
          <div className="p-4" style={{background:'rgba(255,255,255,0.6)', backdropFilter:'blur(20px)', borderTop:'1px solid rgba(0,0,0,0.06)'}}>
            {error && <div className="text-xs text-red-500 mb-2">{error}</div>}
            {voiceMode ? (
              /* 음성 모드 입력 */
              <div className="flex flex-col items-center gap-3">
                {inputText && (
                  <div className="w-full bg-white/80 rounded-xl px-4 py-2 text-sm text-gray-700 border border-gray-200">
                    {inputText}
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <button
                    onMouseDown={startListening}
                    onMouseUp={stopListening}
                    onTouchStart={startListening}
                    onTouchEnd={stopListening}
                    className={\`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg \${
                      isListening
                        ? 'bg-red-500 scale-110 shadow-red-200'
                        : 'bg-gray-900 hover:bg-gray-800 shadow-black/20'
                    }\`}
                  >
                    <Icon d={ICONS.mic} size={24} color="white"/>
                  </button>
                  {inputText && (
                    <button
                      onClick={() => { handleSend(); }}
                      disabled={isLoading}
                      className="px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-xl transition-colors"
                    >
                      전송 →
                    </button>
                  )}
                </div>
                <p className="text-xs text-gray-400">{isListening ? '🔴 듣는 중...' : '버튼을 누르고 말하세요'}</p>
              </div>
            ) : (
              /* 텍스트 모드 입력 */
              <div className="flex gap-3 items-end">
                <textarea
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }}}
                  placeholder="답변을 입력하세요... (Enter 전송, Shift+Enter 줄바꿈)"
                  rows={3}
                  className="flex-1 bg-white/80 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 text-gray-800 leading-relaxed"
                />
                <button
                  onClick={handleSend}
                  disabled={!inputText.trim() || isLoading}
                  className="w-12 h-12 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-200 rounded-xl flex items-center justify-center transition-colors shrink-0"
                >
                  <Icon d={ICONS.send} size={17} color="white"/>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (screen === 'feedback' && feedbackData) {
    const gradeColor = feedbackData.overallScore >= 80 ? 'text-green-600' : feedbackData.overallScore >= 60 ? 'text-gray-900' : 'text-orange-600';
    return (
      <div className="min-h-screen bg-[#f2f0eb]">
        {/* 헤더 */}
        <div className="border-b border-gray-100 bg-white/80 backdrop-blur px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-900 rounded-lg flex items-center justify-center">
              <Icon d={ICONS.mic} size={16} color="white"/>
            </div>
            <span className="font-bold text-gray-900">InterviewAI</span>
            <span className="text-sm text-gray-500">· 면접 결과 리포트</span>
          </div>
          <button onClick={handleReset} className="flex items-center gap-2 text-sm text-gray-900 hover:text-indigo-700 font-medium">
            <Icon d={ICONS.refresh} size={16}/>
            다시 연습하기
          </button>
        </div>

        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* 종합 점수 카드 */}
          <div className="glass rounded-2xl p-6 mb-6 fade-in">
            <div className="flex items-center gap-8">
              <ScoreGauge score={feedbackData.overallScore}/>
              <div className="flex-1">
                <div className="flex items-baseline gap-3 mb-2">
                  <span className={\`text-4xl font-bold \${gradeColor}\`}>{feedbackData.grade}</span>
                  <span className="text-gray-500 text-sm">종합 등급</span>
                </div>
                <p className="text-gray-700 leading-relaxed mb-4">{feedbackData.summary}</p>
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-sm text-gray-600 leading-relaxed">{feedbackData.finalAdvice}</p>
                </div>
              </div>
            </div>
          </div>

          {/* 강점 / 개선점 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
            <div className="bg-green-50 rounded-2xl border border-green-100 p-5">
              <h3 className="font-bold text-green-800 mb-4 flex items-center gap-2">
                <Icon d={ICONS.check} size={18} color="#16a34a"/>
                잘한 점
              </h3>
              <div className="space-y-3">
                {feedbackData.strengths.map((s, i) => (
                  <div key={i} className="flex gap-2 text-sm text-green-700">
                    <span className="shrink-0 w-5 h-5 bg-green-200 rounded-full flex items-center justify-center text-xs font-bold">{i+1}</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-orange-50 rounded-2xl border border-orange-100 p-5">
              <h3 className="font-bold text-orange-800 mb-4 flex items-center gap-2">
                <Icon d={ICONS.target} size={18} color="#ea580c"/>
                개선이 필요한 점
              </h3>
              <div className="space-y-3">
                {feedbackData.improvements.map((imp, i) => (
                  <div key={i} className="flex gap-2 text-sm text-orange-700">
                    <span className="shrink-0 w-5 h-5 bg-orange-200 rounded-full flex items-center justify-center text-xs font-bold">{i+1}</span>
                    <span>{imp}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 화상 피드백 (캡처 프레임이 있었던 경우) */}
          {feedbackData.visualFeedback && (
            <div className="glass rounded-2xl p-6 mb-6 fade-in">
              <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><path d="M23 7l-7 5 7 5V7zM1 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H1a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>
                비언어 커뮤니케이션 분석
              </h3>
              <div className="grid grid-cols-3 gap-4 mb-4">
                {[
                  { label: '시선 처리', key: 'eyeContact' },
                  { label: '자세', key: 'posture' },
                  { label: '표정', key: 'expression' },
                ].map(({ label, key }) => {
                  const item = feedbackData.visualFeedback[key];
                  return (
                    <div key={key} className="bg-white/60 rounded-xl p-4 text-center">
                      <div className="text-2xl font-bold text-gray-900 mb-1">{item?.score}<span className="text-sm text-gray-400">/5</span></div>
                      <div className="text-xs font-semibold text-gray-600 mb-2">{label}</div>
                      <div className="text-xs text-gray-500 leading-relaxed">{item?.comment}</div>
                    </div>
                  );
                })}
              </div>
              <div className="bg-stone-100 rounded-xl p-4 mb-3">
                <p className="text-sm text-gray-700">{feedbackData.visualFeedback.overall}</p>
              </div>
              <div className="flex gap-2 flex-wrap">
                {(feedbackData.visualFeedback.tips || []).map((t, i) => (
                  <span key={i} className="text-xs bg-gray-900 text-white px-3 py-1 rounded-full">{t}</span>
                ))}
              </div>
            </div>
          )}

          {/* 질문별 상세 피드백 */}
          <div className="glass rounded-2xl p-6">
            <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
              <Icon d={ICONS.star} size={18} color="#4f46e5"/>
              질문별 상세 피드백
            </h3>
            <div className="space-y-3">
              {(feedbackData.questionFeedback || []).map((qf, i) => (
                <div key={i} className="border border-gray-100 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setOpenFeedback(openFeedback === i ? null : i)}
                    className="w-full flex items-start justify-between px-4 py-3 hover:bg-gray-50 transition-colors text-left gap-3"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <span className="text-xs font-bold text-gray-500">Q{i+1}</span>
                        <Stars rating={qf.rating}/>
                      </div>
                      <p className="text-sm text-gray-700 font-medium">{qf.question}</p>
                    </div>
                    <Icon d={ICONS.chevron} size={16} color="#9ca3af" className={\`mt-1 shrink-0 transition-transform \${openFeedback === i ? 'rotate-90' : ''}\`}/>
                  </button>
                  {openFeedback === i && (
                    <div className="border-t border-gray-100 bg-gray-50/50 p-4 space-y-3 fade-in">
                      <div>
                        <p className="text-xs font-semibold text-gray-500 mb-1">피드백</p>
                        <p className="text-sm text-gray-700">{qf.feedback}</p>
                      </div>
                      <div className="bg-stone-100 rounded-xl p-3">
                        <p className="text-xs font-semibold text-gray-900 mb-1">더 좋은 답변 예시</p>
                        <p className="text-sm text-gray-800">{qf.betterAnswer}</p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 flex gap-4">
            <button
              onClick={() => { setScreen('interview'); startInterview(); }}
              className="flex-1 py-4 bg-gray-900 hover:bg-gray-800 text-white font-semibold rounded-2xl transition-all shadow-lg shadow-black/10"
            >
              같은 공고로 다시 연습하기
            </button>
            <button
              onClick={handleReset}
              className="flex-1 py-4 bg-white hover:bg-gray-50 text-gray-700 font-semibold rounded-2xl border border-gray-200 transition-all"
            >
              새 공고로 시작하기
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script>
</body>
</html>`;
