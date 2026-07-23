import React, { useState, useEffect, useRef } from 'react';
import { 
  Menu, MessageSquare, Compass, Mic, Plus, ArrowUp, X, Sparkles, ChevronDown, 
  Search, RefreshCw, Volume2, User, Bot, Code, BookOpen, Palette, Dumbbell, Cpu,
  Sun, Moon, ChevronRight, Laptop, Sparkle, Heart, Layout, Smartphone
} from 'lucide-react';

const PRESET_AGENTS = [
  {
    id: 'gpt-4o',
    name: 'ChatGPT Plus (GPT-4o)',
    tagline: 'Our smartest and most versatile model for text, code, and reasoning.',
    icon: Sparkles,
    color: 'from-emerald-500 to-teal-600',
    systemPrompt: 'You are the default helpful AI assistant, highly intellectual, clear, and direct. Keep responses beautifully formatted, clean, and structured.',
    category: 'Featured'
  },
  {
    id: 'o3-mini',
    name: 'o3-mini reasoning',
    tagline: 'Deep reasoning agent optimized for coding, mathematics, and complex logic.',
    icon: Cpu,
    color: 'from-purple-500 to-indigo-600',
    systemPrompt: 'You are o3-mini, a deep reasoning specialist. Before answering, structure your thinking process carefully and solve complex problems with step-by-step logic.',
    category: 'Featured'
  },
  {
    id: 'agent-coder',
    name: 'Code Wizard',
    tagline: 'Writes, reviews, and debugs clean code in any programming language.',
    icon: Code,
    color: 'from-blue-500 to-cyan-600',
    systemPrompt: 'You are Code Wizard, an elite software engineer agent. Provide code blocks with extreme precision, elegant structures, and brief educational comments.',
    category: 'Programming'
  },
  {
    id: 'agent-writer',
    name: 'Creative Storyteller',
    tagline: 'Co-author stories, scripts, essays, or emails with vibrant prose.',
    icon: BookOpen,
    color: 'from-amber-500 to-orange-600',
    systemPrompt: 'You are Creative Storyteller, an award-winning novelist and editor. Speak with a captivating, descriptive, and literary tone. Focus on character, plot, and sensory details.',
    category: 'Writing'
  },
  {
    id: 'agent-designer',
    name: 'Design Critique',
    tagline: 'Expert visual analysis, UX suggestions, and UI design systems.',
    icon: Palette,
    color: 'from-pink-500 to-rose-600',
    systemPrompt: 'You are Design Critique, a veteran creative director. Evaluate interface flows, typography, color harmony, and aesthetic alignment with premium contemporary standards.',
    category: 'Design'
  },
  {
    id: 'agent-fitness',
    name: 'FitCoach AI',
    tagline: 'Personalized workouts, macro breakdowns, and motivational advice.',
    icon: Dumbbell,
    color: 'from-red-500 to-orange-500',
    systemPrompt: 'You are FitCoach AI, an energetic, certified personal trainer and dietitian. Keep responses highly actionable, motivational, structured, and focused on functional health.',
    category: 'Lifestyle'
  }
];

export default function App() {
  const [theme, setTheme] = useState('dark'); // 'dark' | 'light'
  const [currentAgent, setCurrentAgent] = useState(PRESET_AGENTS[0]);
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'assistant',
      content: `Hello! I'm ${PRESET_AGENTS[0].name}. ${PRESET_AGENTS[0].tagline}\nHow can I help you today?`,
      timestamp: new Date()
    }
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  
  // Navigation & UI States
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' | 'explore'
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showVoiceOverlay, setShowVoiceOverlay] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [exploreCategory, setExploreCategory] = useState('All');
  
  // Voice Mode Animation States
  const [voiceIsMuted, setVoiceIsMuted] = useState(false);
  const [voiceState, setVoiceState] = useState('Listening...'); // 'Listening...' | 'Thinking...' | 'Speaking...'
  const [voiceTranscription, setVoiceTranscription] = useState('');
  const [simulatedVoiceLog, setSimulatedVoiceLog] = useState([
    "Tap to speak freely to your agent."
  ]);

  const canvasRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  useEffect(() => {
    if (!showVoiceOverlay) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationId;
    let phase = 0;

    const resizeCanvas = () => {
      canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
      canvas.height = canvas.parentElement.clientHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Audio aura rendering loop (Advanced physical simulation)
    const render = () => {
      const width = canvas.width / window.devicePixelRatio;
      const height = canvas.height / window.devicePixelRatio;
      ctx.clearRect(0, 0, width, height);

      // Radial base color depending on theme selection
      const bgGrad = ctx.createRadialGradient(width / 2, height / 2, 10, width / 2, height / 2, width);
      if (theme === 'dark') {
        bgGrad.addColorStop(0, '#0a0a0d');
        bgGrad.addColorStop(1, '#020203');
      } else {
        bgGrad.addColorStop(0, '#ffffff');
        bgGrad.addColorStop(1, '#f1f5f9');
      }
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // Wave physics settings based on voice action state
      let speed = 0.02;
      let amplitude = 40;
      let complexity = 4;
      
      if (voiceIsMuted) {
        amplitude = 2;
        speed = 0.005;
      } else if (voiceState === 'Thinking...') {
        amplitude = 25;
        speed = 0.08;
        complexity = 6;
      } else if (voiceState === 'Speaking...') {
        amplitude = 75;
        speed = 0.05;
        complexity = 5;
      } else {
        // Listening: gentle pulsing base
        amplitude = 35;
        speed = 0.015;
        complexity = 3;
      }

      phase += speed;

      const center = { x: width / 2, y: height * 0.45 };
      const baseRadius = Math.min(width, height) * 0.22;

      // Layer 1: Outer glow layer
      ctx.beginPath();
      ctx.save();
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'multiply';
      const gradient1 = ctx.createRadialGradient(center.x, center.y, baseRadius * 0.3, center.x, center.y, baseRadius * 1.8);
      
      if (theme === 'dark') {
        gradient1.addColorStop(0, 'rgba(20, 184, 166, 0.4)');
        gradient1.addColorStop(0.5, 'rgba(13, 148, 136, 0.15)');
        gradient1.addColorStop(1, 'rgba(0, 0, 0, 0)');
      } else {
        gradient1.addColorStop(0, 'rgba(45, 212, 191, 0.35)');
        gradient1.addColorStop(0.5, 'rgba(204, 251, 241, 0.15)');
        gradient1.addColorStop(1, 'rgba(255, 255, 255, 0)');
      }
      ctx.fillStyle = gradient1;
      
      ctx.beginPath();
      for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
        const offset = Math.sin(angle * complexity + phase) * amplitude * 0.5 
                     + Math.cos(angle * 2 - phase * 1.5) * amplitude * 0.3;
        const r = baseRadius + offset;
        const x = center.x + Math.cos(angle) * r;
        const y = center.y + Math.sin(angle) * r;
        if (angle === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Layer 2: Core light bright blue
      ctx.save();
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'source-over';
      const gradient2 = ctx.createRadialGradient(center.x, center.y, baseRadius * 0.1, center.x, center.y, baseRadius * 1.2);
      
      if (theme === 'dark') {
        gradient2.addColorStop(0, 'rgba(14, 165, 233, 0.65)');
        gradient2.addColorStop(0.4, 'rgba(2, 132, 199, 0.25)');
        gradient2.addColorStop(1, 'rgba(0, 0, 0, 0)');
      } else {
        gradient2.addColorStop(0, 'rgba(56, 189, 248, 0.45)');
        gradient2.addColorStop(0.4, 'rgba(224, 242, 254, 0.2)');
        gradient2.addColorStop(1, 'rgba(255, 255, 255, 0)');
      }
      ctx.fillStyle = gradient2;

      ctx.beginPath();
      for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
        const offset = Math.cos(angle * (complexity - 1) - phase * 1.2) * amplitude * 0.4 
                     + Math.sin(angle * 3 + phase) * amplitude * 0.25;
        const r = baseRadius * 0.85 + offset;
        const x = center.x + Math.cos(angle) * r;
        const y = center.y + Math.sin(angle) * r;
        if (angle === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Layer 3: Dynamic high contrast energy highlight
      ctx.save();
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'source-over';
      const gradient3 = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, baseRadius * 0.7);
      
      if (theme === 'dark') {
        gradient3.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
        gradient3.addColorStop(0.3, 'rgba(168, 85, 247, 0.4)');
        gradient3.addColorStop(0.7, 'rgba(139, 92, 246, 0.1)');
        gradient3.addColorStop(1, 'rgba(0, 0, 0, 0)');
      } else {
        gradient3.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        gradient3.addColorStop(0.3, 'rgba(192, 132, 252, 0.4)');
        gradient3.addColorStop(0.7, 'rgba(243, 232, 255, 0.15)');
        gradient3.addColorStop(1, 'rgba(255, 255, 255, 0)');
      }
      ctx.fillStyle = gradient3;

      ctx.beginPath();
      for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
        const offset = Math.sin(angle * (complexity + 2) + phase * 2) * amplitude * 0.3;
        const r = baseRadius * 0.5 + offset;
        const x = center.x + Math.cos(angle) * r;
        const y = center.y + Math.sin(angle) * r;
        if (angle === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      animationId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [showVoiceOverlay, voiceState, voiceIsMuted, theme]);

  const startSimulatedVoiceSession = () => {
    setShowVoiceOverlay(true);
    setVoiceState('Listening...');
    setVoiceTranscription('');
    
    // Auto-prompt voice feedback
    setTimeout(() => {
      setVoiceState('Thinking...');
      setVoiceTranscription('Hello, can you help me brainstorm high-concept designs?');
      setSimulatedVoiceLog(prev => [...prev, "User: Hello, can you help me brainstorm high-concept designs?"]);
      
      setTimeout(async () => {
        try {
          const simulatedResponse = await fetchAgentResponse("What are 3 stunning concepts for a futuristic mobile operating system interface?");
          setVoiceState('Speaking...');
          setSimulatedVoiceLog(prev => [...prev, `Agent: ${simulatedResponse}`]);
        } catch (error) {
          setVoiceState('Speaking...');
          setSimulatedVoiceLog(prev => [...prev, "Agent: I can absolutely help you brainstorm visual and functional concepts for premium user interfaces!"]);
        }
      }, 1500);
    }, 3000);
  };

  const fetchAgentResponse = async (userPrompt) => {
    const systemPrompt = currentAgent.systemPrompt;
    const apiKey = ""; // Canvas framework automatically supplies active runtime credentials
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `System context: ${systemPrompt}\n\nUser request: ${userPrompt}` }]
        }
      ]
    };

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || "I was unable to retrieve a response at this moment. Please check your connectivity.";
    } catch (error) {
      console.error("Gemini API Error:", error);
      throw error;
    }
  };

  const handleSendMessage = async (e) => {
    if (e) e.preventDefault();
    if (!inputMessage.trim()) return;

    const userMsg = inputMessage;
    setInputMessage('');
    setIsTyping(true);

    const newMsg = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: userMsg,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, newMsg]);

    try {
      const responseText = await fetchAgentResponse(userMsg);
      setMessages(prev => [...prev, {
        id: `msg-${Date.now() + 1}`,
        role: 'assistant',
        content: responseText,
        timestamp: new Date()
      }]);
    } catch (error) {
      setTimeout(() => {
        setMessages(prev => [...prev, {
          id: `msg-${Date.now() + 1}`,
          role: 'assistant',
          content: `Hi! This is a mock response from ${currentAgent.name}. It seems there was an issue querying Gemini directly, but I am ready to help you plan, code, and execute your projects!`,
          timestamp: new Date()
        }]);
      }, 1000);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSelectAgent = (agent) => {
    setCurrentAgent(agent);
    setActiveTab('chat');
    setShowModelDropdown(false);
    setMessages([
      {
        id: `welcome-${agent.id}`,
        role: 'assistant',
        content: `Hi there! I am ${agent.name}.\n${agent.tagline}\nHow can we collaborate together?`,
        timestamp: new Date()
      }
    ]);
  };

  // Searching filter for Directory items
  const filteredAgents = PRESET_AGENTS.filter(agent => {
    const matchesSearch = agent.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          agent.tagline.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = exploreCategory === 'All' || agent.category === exploreCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className={`min-h-screen transition-colors duration-500 flex flex-col lg:flex-row items-center justify-center p-4 lg:p-10 font-sans selection:bg-teal-500/30 ${theme === 'dark' ? 'bg-[#09090b] text-zinc-100' : 'bg-[#f4f4f5] text-zinc-900'}`}>
      
      {/* Dynamic Background visual ornaments */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <div className={`absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full filter blur-[120px] opacity-25 transition-all duration-700 ${theme === 'dark' ? 'bg-teal-900/30' : 'bg-teal-200/40'}`}></div>
        <div className={`absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full filter blur-[120px] opacity-25 transition-all duration-700 ${theme === 'dark' ? 'bg-purple-900/30' : 'bg-purple-200/40'}`}></div>
      </div>

      {/* Presentation view + Mockup side-by-side */}
      <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-10 items-center z-10">
        
        {/* Left Side: Product Details & Dynamic Theme Controllers */}
        <div className="lg:col-span-5 space-y-6 text-left">
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold tracking-wide ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-teal-400' : 'bg-white border-zinc-200 text-teal-600 shadow-xs'}`}>
            <Sparkles className="w-4 h-4 animate-pulse" />
            ChatGPT Mobile Codex Design System
          </div>
          
          <h1 className="text-4xl lg:text-5xl font-black tracking-tight leading-tight">
            Next-Gen <br />
            <span className="bg-gradient-to-r from-emerald-500 via-teal-400 to-sky-400 bg-clip-text text-transparent">Agent Portal</span>
          </h1>

          <p className={`text-sm lg:text-base leading-relaxed transition-all duration-300 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Experience a gorgeous 100% responsive smartphone simulator reflecting OpenAI's latest design guidelines. Featuring deep integration for custom agents, dynamic layout configurations, and a complete light/dark adaptation system.
          </p>
          
          {/* Theme Interactive Switcher Widget */}
          <div className={`p-4 rounded-3xl border transition-all duration-300 ${theme === 'dark' ? 'bg-[#121215] border-zinc-800' : 'bg-white border-zinc-200 shadow-xs'}`}>
            <p className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-3 flex items-center gap-1.5">
              <Layout className="w-3.5 h-3.5 text-teal-500" />
              Interactive Theme Selector
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={() => setTheme('dark')}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-xs font-bold transition-all ${theme === 'dark' ? 'bg-zinc-800 text-teal-400 shadow-sm border border-zinc-700' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-600'}`}
              >
                <Moon className="w-4 h-4" />
                Mystic Dark (深色)
              </button>
              <button 
                onClick={() => setTheme('light')}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-xs font-bold transition-all ${theme === 'light' ? 'bg-zinc-100 text-teal-600 shadow-sm border border-zinc-300' : 'bg-zinc-900/40 hover:bg-zinc-900/60 text-zinc-300'}`}
              >
                <Sun className="w-4 h-4" />
                Pure Light (浅色)
              </button>
            </div>
          </div>

          <div className="space-y-3.5 border-t border-zinc-800/10 dark:border-zinc-800/50 pt-5 text-xs">
            <div className="flex items-start gap-3">
              <div className={`p-2 rounded-xl shrink-0 ${theme === 'dark' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-500/10 text-emerald-600'}`}>
                <Smartphone className="w-4 h-4" />
              </div>
              <div>
                <h4 className="font-bold">Two Complete Theme Shells</h4>
                <p className={theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}>Oversaturated midnight palette and elegant white minimalism across all views.</p>
              </div>
            </div>
            
            <div className="flex items-start gap-3">
              <div className={`p-2 rounded-xl shrink-0 ${theme === 'dark' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-indigo-500/10 text-indigo-600'}`}>
                <Mic className="w-4 h-4" />
              </div>
              <div>
                <h4 className="font-bold">Adaptive Advanced Voice Canvas</h4>
                <p className={theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}>The morphing core changes background and glow dynamics based on light reflection properties.</p>
              </div>
            </div>
          </div>
        </div>

        {}
        {/* Right Side: High-fidelity phone device simulator */}
        <div className="lg:col-span-7 flex justify-center">
          <div className={`w-[385px] h-[785px] rounded-[52px] border-[12px] shadow-2xl overflow-hidden relative flex flex-col transition-all duration-300 ring-4 ${theme === 'dark' ? 'bg-black border-zinc-900 ring-zinc-800' : 'bg-white border-zinc-300 ring-zinc-200'}`}>
            
            {/* Phone Notch & Status indicators bar */}
            <div className="absolute top-0 inset-x-0 h-11 bg-black z-50 flex items-center justify-between px-6 select-none pointer-events-none">
              <span className="text-[11px] font-bold text-white">9:41</span>
              {/* Dynamic Island Capsule */}
              <div className="w-24 h-5 bg-black rounded-full flex items-center justify-center border border-zinc-850/50">
                <div className="w-3 h-3 bg-zinc-950 rounded-full mr-2"></div>
                <div className="w-1.5 h-1.5 bg-zinc-900 rounded-full"></div>
              </div>
              <div className="flex items-center gap-1.5 text-white">
                <span className="text-[9px] font-bold">5G</span>
                <div className="w-5 h-2.5 border border-zinc-400 rounded-xs p-0.5 flex items-center">
                  <div className="w-3.5 h-full bg-emerald-500 rounded-3xs"></div>
                </div>
              </div>
            </div>

            {}
            {/* Drawer Sidebar Menu */}
            {sidebarOpen && (
              <div className="absolute inset-0 z-40 flex">
                <div className={`w-3/4 h-full p-6 flex flex-col justify-between border-r shadow-2xl animate-in slide-in-from-left duration-300 ${theme === 'dark' ? 'bg-[#121214] border-zinc-800' : 'bg-white border-zinc-200'}`}>
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-teal-500 font-bold">
                        <Sparkles className="w-5 h-5" />
                        <span className="text-sm">Codex Space</span>
                      </div>
                      <button 
                        onClick={() => setSidebarOpen(false)} 
                        className={`p-1.5 rounded-full transition ${theme === 'dark' ? 'hover:bg-zinc-800 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500'}`}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="space-y-2">
                      <p className="text-[9px] font-bold text-zinc-400 tracking-wider uppercase">Active Agent</p>
                      <div className={`flex items-center gap-3 p-3 rounded-xl border ${theme === 'dark' ? 'bg-zinc-900 border-zinc-850' : 'bg-zinc-50 border-zinc-200'}`}>
                        <div className={`p-2 rounded-lg bg-gradient-to-tr ${currentAgent.color} text-white`}>
                          <currentAgent.icon className="w-4 h-4" />
                        </div>
                        <div className="truncate">
                          <h4 className={`font-bold text-xs ${theme === 'dark' ? 'text-zinc-200' : 'text-zinc-800'}`}>{currentAgent.name}</h4>
                          <p className="text-[10px] text-zinc-400 truncate">{currentAgent.tagline}</p>
                        </div>
                      </div>
                    </div>

                    <nav className="space-y-1">
                      <p className="text-[9px] font-bold text-zinc-400 tracking-wider uppercase mb-2">Shortcuts</p>
                      <button 
                        onClick={() => { setActiveTab('chat'); setSidebarOpen(false); }}
                        className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-xs font-semibold transition-all ${activeTab === 'chat' ? (theme === 'dark' ? 'bg-zinc-800 text-teal-400' : 'bg-zinc-100 text-teal-600') : (theme === 'dark' ? 'text-zinc-400 hover:bg-zinc-900' : 'text-zinc-600 hover:bg-zinc-50')}`}
                      >
                        <MessageSquare className="w-4 h-4" />
                        <span>Interactive Chat</span>
                      </button>
                      <button 
                        onClick={() => { setActiveTab('explore'); setSidebarOpen(false); }}
                        className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-xs font-semibold transition-all ${activeTab === 'explore' ? (theme === 'dark' ? 'bg-zinc-800 text-teal-400' : 'bg-zinc-100 text-teal-600') : (theme === 'dark' ? 'text-zinc-400 hover:bg-zinc-900' : 'text-zinc-600 hover:bg-zinc-50')}`}
                      >
                        <Compass className="w-4 h-4" />
                        <span>Explore Agents Directory</span>
                      </button>
                    </nav>

                    {/* Chat History simulation list */}
                    <div className="space-y-1.5">
                      <p className="text-[9px] font-bold text-zinc-400 tracking-wider uppercase">History</p>
                      <div className="text-[11px] space-y-1">
                        <div className={`p-2 rounded-lg truncate flex items-center gap-2 ${theme === 'dark' ? 'text-zinc-300 hover:bg-zinc-900' : 'text-zinc-700 hover:bg-zinc-100'}`}>
                          <MessageSquare className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                          <span className="truncate">Design feedback checklist</span>
                        </div>
                        <div className={`p-2 rounded-lg truncate flex items-center gap-2 ${theme === 'dark' ? 'text-zinc-300 hover:bg-zinc-900' : 'text-zinc-700 hover:bg-zinc-100'}`}>
                          <MessageSquare className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                          <span className="truncate">Custom prompt guidelines</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Profile info inside drawer footer */}
                  <div className={`border-t pt-4 flex items-center gap-3 ${theme === 'dark' ? 'border-zinc-800' : 'border-zinc-200'}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${theme === 'dark' ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-150 text-zinc-600'}`}>
                      <User className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className={`text-xs font-bold ${theme === 'dark' ? 'text-zinc-200' : 'text-zinc-800'}`}>Designer Guest</h4>
                      <p className="text-[9px] text-teal-500 font-semibold uppercase tracking-wider">Premium Plus tier</p>
                    </div>
                  </div>
                </div>
                {/* Backdrop overlay */}
                <div className="flex-1 bg-black/50 backdrop-blur-xs" onClick={() => setSidebarOpen(false)}></div>
              </div>
            )}

            {}
            {/* Header section with toggle option */}
            <header className={`pt-12 pb-3 px-4 flex items-center justify-between z-30 sticky top-0 border-b transition-all ${theme === 'dark' ? 'bg-zinc-950/90 border-zinc-900/50 text-white' : 'bg-white/90 border-zinc-200/50 text-zinc-800'}`}>
              <button 
                onClick={() => setSidebarOpen(true)}
                className={`p-1.5 rounded-lg transition ${theme === 'dark' ? 'hover:bg-zinc-900' : 'hover:bg-zinc-100'}`}
              >
                <Menu className="w-5 h-5" />
              </button>

              {/* Middle Dropdown Selector trigger */}
              <div className="relative">
                <button 
                  onClick={() => setShowModelDropdown(!showModelDropdown)}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-bold transition-all duration-300 ${theme === 'dark' ? 'bg-zinc-900 hover:bg-zinc-850 border-zinc-800 text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200 border-zinc-200 text-zinc-800'}`}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span className="max-w-[120px] truncate">{currentAgent.name}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                </button>

                {showModelDropdown && (
                  <>
                    <div className="fixed inset-0 z-45" onClick={() => setShowModelDropdown(false)}></div>
                    <div className={`absolute top-full mt-2 left-1/2 -translate-x-1/2 w-56 border rounded-2xl p-2 shadow-2xl z-50 animate-in fade-in slide-in-from-top-2 duration-200 ${theme === 'dark' ? 'bg-[#161618] border-zinc-800 text-zinc-200' : 'bg-white border-zinc-200 text-zinc-800'}`}>
                      <p className="text-[9px] font-bold text-zinc-400 tracking-wider uppercase px-2 py-1 mb-1">Select Custom Expert</p>
                      <div className="space-y-1">
                        {PRESET_AGENTS.map((agent) => (
                          <button
                            key={agent.id}
                            onClick={() => handleSelectAgent(agent)}
                            className={`w-full flex items-center justify-between p-2 rounded-xl text-left text-xs transition-all ${currentAgent.id === agent.id ? (theme === 'dark' ? 'bg-zinc-800 text-teal-300' : 'bg-zinc-100 text-teal-600') : (theme === 'dark' ? 'text-zinc-400 hover:bg-zinc-900/60' : 'text-zinc-600 hover:bg-zinc-50')}`}
                          >
                            <div className="flex items-center gap-2 truncate">
                              <div className={`p-1.5 rounded-md bg-gradient-to-tr ${agent.color} text-white`}>
                                <agent.icon className="w-3 h-3" />
                              </div>
                              <span className="font-semibold truncate">{agent.name}</span>
                            </div>
                            {currentAgent.id === agent.id && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                          </button>
                        ))}
                      </div>
                      <div className="border-t border-zinc-800/20 dark:border-zinc-800 mt-2 pt-1.5 px-2">
                        <button 
                          onClick={() => { setActiveTab('explore'); setShowModelDropdown(false); }}
                          className="w-full flex items-center gap-1.5 text-[10px] font-semibold text-zinc-400 hover:text-teal-400"
                        >
                          <Compass className="w-3.5 h-3.5" />
                          Discover more agents
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Dynamic theme quick switch inside device header layout */}
              <button 
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className={`p-1.5 rounded-lg transition ${theme === 'dark' ? 'hover:bg-zinc-900 text-yellow-400' : 'hover:bg-zinc-100 text-indigo-500'}`}
                title="Toggle visual style"
              >
                {theme === 'dark' ? <Sun className="w-4.5 h-4.5" /> : <Moon className="w-4.5 h-4.5" />}
              </button>
            </header>

            {}
            {/* VIEWPORT 1: CHAT TIMELINE */}
            {activeTab === 'chat' && (
              <div className={`flex-1 overflow-y-auto px-4 py-3 flex flex-col space-y-5 scrollbar-none pb-24 transition-colors duration-300 ${theme === 'dark' ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
                
                {/* Empty welcome landing wrapper */}
                {messages.length <= 1 && (
                  <div className="flex flex-col items-center text-center py-12 space-y-4 animate-in fade-in duration-500">
                    <div className={`w-16 h-16 rounded-3xl bg-gradient-to-tr ${currentAgent.color} flex items-center justify-center text-white shadow-xl ring-4 ring-neutral-900/10`}>
                      <currentAgent.icon className="w-8 h-8" />
                    </div>
                    <div>
                      <h2 className={`text-lg font-black tracking-tight ${theme === 'dark' ? 'text-zinc-100' : 'text-zinc-800'}`}>{currentAgent.name}</h2>
                      <p className="text-xs text-zinc-400 max-w-[260px] mx-auto mt-1 leading-normal">{currentAgent.tagline}</p>
                    </div>
                    
                    {/* Prompt suggestions items */}
                    <div className="w-full grid grid-cols-2 gap-2 mt-6 text-left max-w-sm pt-4">
                      <div 
                        onClick={() => setInputMessage("Recommend 3 premium mock palettes for our brand layout.")}
                        className={`p-3.5 border rounded-2xl cursor-pointer transition-all ${theme === 'dark' ? 'bg-zinc-900/60 border-zinc-900 hover:bg-zinc-900 hover:border-zinc-800' : 'bg-white border-zinc-200/80 hover:bg-zinc-100/50 hover:border-zinc-300 shadow-2xs'}`}
                      >
                        <p className={`font-bold text-xs ${theme === 'dark' ? 'text-zinc-300' : 'text-zinc-800'}`}>Brand Palettes</p>
                        <p className="text-[10px] text-zinc-400 mt-1 line-clamp-2">Aesthetic colors scheme ideas for modern dark and light views.</p>
                      </div>
                      <div 
                        onClick={() => setInputMessage("Structure a high performance responsive viewport architecture.")}
                        className={`p-3.5 border rounded-2xl cursor-pointer transition-all ${theme === 'dark' ? 'bg-zinc-900/60 border-zinc-900 hover:bg-zinc-900 hover:border-zinc-800' : 'bg-white border-zinc-200/80 hover:bg-zinc-100/50 hover:border-zinc-300 shadow-2xs'}`}
                      >
                        <p className={`font-bold text-xs ${theme === 'dark' ? 'text-zinc-300' : 'text-zinc-800'}`}>UI Architecture</p>
                        <p className="text-[10px] text-zinc-400 mt-1 line-clamp-2">Configuring viewport parameters cleanly across layout frameworks.</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Render chat message records */}
                {messages.map((msg) => (
                  <div 
                    key={msg.id}
                    className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
                  >
                    {msg.role === 'user' ? (
                      <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-xs leading-relaxed shadow-2xs font-medium ${theme === 'dark' ? 'bg-zinc-800 text-zinc-100' : 'bg-zinc-200 text-zinc-900'}`}>
                        {msg.content}
                      </div>
                    ) : (
                      <div className="space-y-2 w-full">
                        <div className="flex items-center gap-2">
                          <div className={`p-1 rounded-md bg-gradient-to-tr ${currentAgent.color} text-white`}>
                            <currentAgent.icon className="w-3.5 h-3.5" />
                          </div>
                          <span className="text-[9px] font-bold text-zinc-400 tracking-wider uppercase">{currentAgent.name}</span>
                        </div>
                        <div className={`text-xs leading-relaxed whitespace-pre-wrap pl-1 select-text ${theme === 'dark' ? 'text-zinc-200' : 'text-zinc-800'}`}>
                          {msg.content}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Streaming response text simulation */}
                {isTyping && (
                  <div className="flex flex-col items-start space-y-2 animate-pulse">
                    <div className="flex items-center gap-2">
                      <div className={`p-1 rounded-md bg-gradient-to-tr ${currentAgent.color} text-white`}>
                        <currentAgent.icon className="w-3.5 h-3.5" />
                      </div>
                      <span className="text-[9px] font-bold text-zinc-400 tracking-wider uppercase">Evaluating inputs...</span>
                    </div>
                    <div className="flex items-center gap-1 pl-1.5 py-1">
                      <span className="w-1.5 h-1.5 bg-teal-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 bg-teal-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 bg-teal-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}

            {}
            {/* VIEWPORT 2: DIRECTORY */}
            {activeTab === 'explore' && (
              <div className={`flex-1 overflow-y-auto px-4 py-5 scrollbar-none space-y-6 pb-20 transition-colors duration-300 ${theme === 'dark' ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
                <div className="space-y-2">
                  <h2 className={`text-lg font-black tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-800'}`}>Custom Agents</h2>
                  <p className="text-[11px] text-zinc-400 leading-normal">Instantly hook into specialised logic structures tailored for deep creative pipelines.</p>
                </div>

                {/* Search query input */}
                <div className="relative">
                  <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input 
                    type="text" 
                    placeholder="Search tailored agents..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className={`w-full border rounded-xl py-2 pl-9 pr-4 text-xs focus:outline-none focus:border-teal-500 transition-all ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-zinc-200 placeholder-zinc-500' : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 shadow-2xs'}`}
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                      <X className="w-3.5 h-3.5 text-zinc-400 hover:text-zinc-600" />
                    </button>
                  )}
                </div>

                {/* Filter categories tabs scrollable view */}
                <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-1">
                  {['All', 'Featured', 'Programming', 'Writing', 'Design', 'Lifestyle'].map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setExploreCategory(cat)}
                      className={`px-3 py-1 rounded-full text-[10px] font-bold whitespace-nowrap transition-all ${exploreCategory === cat ? 'bg-teal-500/20 text-teal-400 border border-teal-500/30' : (theme === 'dark' ? 'bg-zinc-900 text-zinc-400 hover:text-white' : 'bg-zinc-200/60 text-zinc-600 hover:bg-zinc-200')}`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                {/* Custom list of Agents cards */}
                <div className="space-y-3">
                  <p className="text-[9px] font-bold text-zinc-400 tracking-wider uppercase">Directory results ({filteredAgents.length})</p>
                  <div className="space-y-2.5">
                    {filteredAgents.map((agent) => (
                      <div 
                        key={agent.id}
                        onClick={() => handleSelectAgent(agent)}
                        className={`group flex items-start justify-between p-3 border rounded-2xl cursor-pointer transition-all ${theme === 'dark' ? 'bg-zinc-900/40 hover:bg-zinc-900 border-zinc-900 hover:border-zinc-800' : 'bg-white hover:bg-zinc-100/50 border-zinc-200 shadow-2xs'}`}
                      >
                        <div className="flex items-start gap-3 truncate">
                          <div className={`p-2 rounded-xl bg-gradient-to-tr ${agent.color} text-white shadow-xs shrink-0`}>
                            <agent.icon className="w-4.5 h-4.5" />
                          </div>
                          <div className="truncate text-left">
                            <div className="flex items-center gap-2">
                              <h3 className={`font-bold text-xs group-hover:text-teal-500 transition-colors ${theme === 'dark' ? 'text-zinc-200' : 'text-zinc-850'}`}>{agent.name}</h3>
                              <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold ${theme === 'dark' ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`}>{agent.category}</span>
                            </div>
                            <p className="text-[10px] text-zinc-400 mt-0.5 line-clamp-2 leading-relaxed">{agent.tagline}</p>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-zinc-400 shrink-0 self-center" />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Simulated Custom Agent Creator Form Banner */}
                <div className={`p-4 border rounded-3xl text-center space-y-3 ${theme === 'dark' ? 'bg-gradient-to-br from-zinc-900 to-zinc-950 border-zinc-800' : 'bg-zinc-100 border-zinc-200/80 shadow-2xs'}`}>
                  <div className="w-10 h-10 rounded-full bg-teal-500/10 flex items-center justify-center mx-auto text-teal-500">
                    <Bot className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className={`text-xs font-bold ${theme === 'dark' ? 'text-zinc-200' : 'text-zinc-800'}`}>Have an idea for an Agent?</h3>
                    <p className="text-[10px] text-zinc-400 mt-0.5">Build a tailored custom model with your rules, resources, and workflows.</p>
                  </div>
                  <button className={`w-full py-2 rounded-xl text-xs font-semibold transition-all ${theme === 'dark' ? 'bg-zinc-850 hover:bg-zinc-850/80 text-zinc-200 border border-zinc-800' : 'bg-white hover:bg-zinc-50 text-zinc-700 border border-zinc-200 shadow-3xs'}`}>
                    Initiate Agent Builder
                  </button>
                </div>
              </div>
            )}

            {}
            {/* Bottom Form control and micro action triggers */}
            {activeTab === 'chat' && (
              <div className={`absolute bottom-0 inset-x-0 pt-6 pb-6 px-4 z-20 transition-all ${theme === 'dark' ? 'bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent' : 'bg-gradient-to-t from-zinc-50 via-zinc-50 to-transparent'}`}>
                <form 
                  onSubmit={handleSendMessage}
                  className={`border rounded-[28px] p-1.5 flex items-center justify-between shadow-lg transition-all focus-within:border-teal-500 ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-zinc-200'}`}
                >
                  <div className="flex items-center gap-1">
                    <button 
                      type="button"
                      className="p-2 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-teal-500 transition-colors"
                    >
                      <Plus className="w-4.5 h-4.5" />
                    </button>
                  </div>

                  {/* Core input field placeholder customisation */}
                  <input 
                    type="text"
                    placeholder={`Message ${currentAgent.name}...`}
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    className={`flex-1 bg-transparent px-3 py-1 text-xs focus:outline-none ${theme === 'dark' ? 'text-zinc-200 placeholder-zinc-500' : 'text-zinc-800 placeholder-zinc-400'}`}
                  />

                  {/* Dynamic control keys based on message presence */}
                  <div className="flex items-center gap-1.5">
                    {inputMessage.trim() ? (
                      <button 
                        type="submit"
                        className={`p-2 rounded-full transition-all shadow-md ${theme === 'dark' ? 'bg-zinc-100 hover:bg-white text-zinc-950' : 'bg-zinc-900 hover:bg-black text-zinc-100'}`}
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                    ) : (
                      <button 
                        type="button"
                        onClick={startSimulatedVoiceSession}
                        className="p-2 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-teal-500 transition-colors"
                        title="Enter Advanced Voice Mode"
                      >
                        <Mic className="w-4.5 h-4.5" />
                      </button>
                    )}
                  </div>
                </form>
              </div>
            )}

            {/* Bottom global app navigation bars */}
            <div className={`absolute bottom-0 inset-x-0 h-12 border-t flex items-center justify-around px-10 z-15 transition-colors ${theme === 'dark' ? 'bg-zinc-950/95 border-zinc-900' : 'bg-white/95 border-zinc-200'}`}>
              <button 
                onClick={() => setActiveTab('chat')}
                className={`flex flex-col items-center justify-center w-12 h-full transition-colors ${activeTab === 'chat' ? 'text-teal-500' : 'text-zinc-400 hover:text-zinc-300'}`}
              >
                <MessageSquare className="w-4.5 h-4.5" />
                <span className="text-[8px] font-bold mt-0.5">Chat</span>
              </button>
              <button 
                onClick={() => setActiveTab('explore')}
                className={`flex flex-col items-center justify-center w-12 h-full transition-colors ${activeTab === 'explore' ? 'text-teal-500' : 'text-zinc-400 hover:text-zinc-300'}`}
              >
                <Compass className="w-4.5 h-4.5" />
                <span className="text-[8px] font-bold mt-0.5">Explore</span>
              </button>
            </div>

            {}
            {/* FULL VOICE OVERLAY PORTAL */}
            {showVoiceOverlay && (
              <div className={`absolute inset-0 z-50 flex flex-col justify-between p-6 animate-in fade-in duration-300 ${theme === 'dark' ? 'bg-[#020203]' : 'bg-[#f8fafc]'}`}>
                {/* Voice background visual canvas aura */}
                <div className="absolute inset-0 z-0 opacity-85 pointer-events-none">
                  <canvas ref={canvasRef} className="w-full h-full" />
                </div>

                {/* Overlay Navigation Headers */}
                <div className="flex items-center justify-between z-10 relative">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-teal-400 animate-ping"></span>
                    <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">Advanced Voice Mode</span>
                  </div>
                  <button 
                    onClick={() => setShowVoiceOverlay(false)}
                    className={`p-2 rounded-full border transition-colors ${theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/50 text-zinc-300 hover:bg-zinc-800' : 'bg-white/80 border-zinc-200/50 text-zinc-600 hover:bg-zinc-100 shadow-3xs'}`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Center Status Indicators */}
                <div className="flex flex-col items-center text-center space-y-4 z-10 relative mt-16">
                  <div className={`p-4 rounded-3xl bg-gradient-to-tr ${currentAgent.color} text-white shadow-xl ring-4 ring-black/5 dark:ring-neutral-900/60`}>
                    <currentAgent.icon className="w-9 h-9" />
                  </div>
                  <div>
                    <h2 className={`text-xl font-black tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-850'}`}>{currentAgent.name}</h2>
                    <p className={`text-xs font-bold tracking-widest mt-1.5 transition-all duration-300 ${voiceState === 'Speaking...' ? 'text-teal-500' : voiceState === 'Thinking...' ? 'text-purple-500 animate-pulse' : 'text-zinc-400'}`}>
                      {voiceState}
                    </p>
                  </div>
                </div>

                {/* Live session log transcript area */}
                <div className={`w-full border p-4 min-h-[110px] flex flex-col justify-end text-left space-y-1.5 z-10 relative select-none rounded-2xl ${theme === 'dark' ? 'bg-zinc-950/70 border-zinc-900/50' : 'bg-white/85 border-zinc-200/80 shadow-xs'}`}>
                  <p className="text-[8px] font-bold text-teal-500 tracking-widest uppercase">Live Session Transcript</p>
                  <div className="space-y-1 max-h-[85px] overflow-y-auto scrollbar-none text-[11px]">
                    {simulatedVoiceLog.map((log, index) => (
                      <p 
                        key={index} 
                        className={`leading-relaxed ${log.startsWith('User') ? 'text-zinc-400 font-semibold' : log.startsWith('Agent') ? 'text-teal-600 font-bold' : 'text-zinc-400'}`}
                      >
                        {log}
                      </p>
                    ))}
                  </div>
                </div>

                {/* Mic and status controllers inside footer */}
                <div className="flex items-center justify-around py-4 z-10 relative">
                  <button 
                    onClick={() => {
                      setVoiceIsMuted(!voiceIsMuted);
                      setVoiceState(voiceIsMuted ? 'Listening...' : 'Muted');
                    }}
                    className={`p-4 rounded-full border transition-colors ${voiceIsMuted ? 'bg-red-500/20 text-red-500 border-red-500/30' : (theme === 'dark' ? 'bg-zinc-900/60 hover:bg-zinc-850 border-zinc-800 text-zinc-300' : 'bg-white hover:bg-zinc-50 border-zinc-200 text-zinc-600 shadow-2xs')}`}
                  >
                    {voiceIsMuted ? <Volume2 className="w-5 h-5 animate-pulse text-red-500" /> : <Mic className="w-5 h-5" />}
                  </button>

                  <button 
                    onClick={() => {
                      setVoiceState('Thinking...');
                      setTimeout(() => {
                        setVoiceState('Speaking...');
                        setSimulatedVoiceLog(prev => [...prev, "Agent: Sure thing! I am adjusting parameters dynamically for your project requirements."]);
                      }, 1500);
                    }}
                    className={`p-4 rounded-full border transition-colors ${theme === 'dark' ? 'bg-zinc-900/60 hover:bg-zinc-850 border-zinc-800 text-zinc-300' : 'bg-white hover:bg-zinc-50 border-zinc-200 text-zinc-600 shadow-2xs'}`}
                  >
                    <RefreshCw className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>

      </div>
    </div>
  );
}