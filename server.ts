import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// Shared server-side Gemini client
const getAiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('MISSING_API_KEY');
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1alpha',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

// Health and quota check
app.get('/api/health', (req, res) => {
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  res.json({
    status: 'ok',
    hasApiKey: hasKey,
    freeTierNotice: 'الخدمة تعمل بنسبة 100% مجاناً عبر نماذج Google Gemini Free Tier دون أي تكاليف أو بطاقة مصرفية.',
  });
});

// Single-speaker TTS Endpoint
app.post('/api/tts/generate', async (req, res) => {
  try {
    const {
      text,
      voice = 'Fenrir',
      styleDescription,
      pace = 1.0,
      pitch = 'normal',
      formality = 'high',
      energy = 'medium',
      language = 'ar',
      dialect = 'fusha',
    } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        errorType: 'INVALID_INPUT',
        message: 'النص المطلوب توليده فارغ. يرجى إدخال نص باللغة العربية أو الإنجليزية.',
      });
    }

    if (text.length > 3000) {
      return res.status(400).json({
        success: false,
        errorType: 'TEXT_TOO_LONG',
        message: 'النص طويل جداً (الحد الأقصى للمقطع الواحد في الفئة المجانية 3000 حرف لتفادي استنزاف الحصة).',
      });
    }

    let ai;
    try {
      ai = getAiClient();
    } catch {
      return res.status(500).json({
        success: false,
        errorType: 'MISSING_API_KEY',
        message: 'مفتاح GEMINI_API_KEY غير متوفر في متغيرات البيئة. يرجى التحقق من إعدادات المفتاح في المنصة.',
      });
    }

    // Compose rich acoustic style prompt for Gemini TTS
    const styleDirectives: string[] = [];

    if (styleDescription) {
      styleDirectives.push(styleDescription);
    }

    // Pitch & Resonance
    if (pitch === 'deep') {
      styleDirectives.push('Deep resonant baritone voice, authoritative chest resonance');
    } else if (pitch === 'very_deep') {
      styleDirectives.push('Ultra-deep, cinematic heavy baritone resonance');
    } else if (pitch === 'warm') {
      styleDirectives.push('Warm, velvety, intimate baritone tone');
    } else {
      styleDirectives.push('Masculine, poised, and clear baritone register');
    }

    // Energy & Formality
    if (formality === 'high') {
      styleDirectives.push('Highly formal, distinguished, presidential media delivery');
    } else if (formality === 'casual') {
      styleDirectives.push('Conversational, relatable, polished podcast tone');
    }

    if (energy === 'high') {
      styleDirectives.push('Energetic, captivating, dynamic vocal inflections');
    } else if (energy === 'calm') {
      styleDirectives.push('Calm, measured, steady, and soothing cadence');
    }

    // Language / Dialect cue
    if (language === 'ar') {
      if (dialect === 'iraqi') {
        styleDirectives.push('Arabic with an authentic, prestigious Iraqi media broadcaster accent, natural and eloquent');
      } else {
        styleDirectives.push('Impeccable Modern Standard Arabic (فصحى راقية), clear diction, and natural pauses');
      }
    } else {
      styleDirectives.push('Fluent, sophisticated English narration with deep vocal weight');
    }

    // Pacing hint in directive
    if (pace < 0.9) {
      styleDirectives.push('Slow, solemn, deliberate pacing with noticeable pauses');
    } else if (pace > 1.1) {
      styleDirectives.push('Brisk, fluent, confident pacing');
    }

    const combinedStyle = styleDirectives.join(', ');

    // Use gemini-3.8-flash-tts as specified in feature block
    const modelToUse = 'gemini-3.8-flash-tts';

    // Map voice name safely: Gemini prebuilt voices: 'Fenrir', 'Charon', 'Puck', 'Zephyr', 'Kore'
    const allowedVoices = ['Fenrir', 'Charon', 'Puck', 'Zephyr', 'Kore'];
    const selectedVoice = allowedVoices.includes(voice) ? voice : 'Fenrir';

    let response;
    try {
      response = await ai.models.generateContent({
        model: modelToUse,
        contents: text.trim(),
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: selectedVoice },
            },
          },
        },
      });
    } catch (primaryErr: any) {
      // Check if it's a quota error
      const errStr = String(primaryErr?.message || primaryErr);
      console.warn('TTS Primary Attempt with gemini-3.8-flash-tts failed:', errStr);

      if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
        return res.status(429).json({
          success: false,
          errorType: 'QUOTA_EXCEEDED',
          message: 'تم الوصول إلى الحد الأقصى لمعدل الطلبات في الحصة المجانية لـ Gemini API (429 Too Many Requests). يرجى الانتظار 30-60 ثانية ثم النقر على زر "إعادة التوليد".',
          retryAfterSeconds: 45,
        });
      }

      // If flash-tts is temporarily busy or unavailable, attempt fallback to gemini-3.8-flash-lite-tts
      console.log('Attempting fallback to gemini-3.8-flash-lite-tts...');
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: text.trim(),
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: selectedVoice },
              },
            },
          },
        });
      } catch (fallbackErr: any) {
        const fallbackMsg = String(fallbackErr?.message || fallbackErr);
        if (fallbackMsg.includes('429') || fallbackMsg.includes('RESOURCE_EXHAUSTED')) {
          return res.status(429).json({
            success: false,
            errorType: 'QUOTA_EXCEEDED',
            message: 'انتهت الحصة المجانية المؤقتة لـ Gemini API. يرجى الانتظار قليلاً قبل المحاولة التالية.',
            retryAfterSeconds: 60,
          });
        }
        throw fallbackErr;
      }
    }

    const candidate = response.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData?.mimeType?.startsWith('audio/'));
    const base64Audio = audioPart?.inlineData?.data;

    if (!base64Audio) {
      return res.status(502).json({
        success: false,
        errorType: 'AUDIO_EXTRACTION_FAILED',
        message: 'لم يرجع النموذج مقطعاً صوتياً صالحاً. يرجى تجربة تعديل النص أو الصياغة وإعادة المحاولة.',
      });
    }

    return res.json({
      success: true,
      audioBase64: base64Audio,
      mimeType: audioPart?.inlineData?.mimeType || 'audio/wav',
      voiceUsed: selectedVoice,
      modelUsed: modelToUse,
      styleUsed: combinedStyle,
    });
  } catch (error: any) {
    console.error('Error generating single-speaker TTS:', error);
    const errMsg = String(error?.message || error);
    if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({
        success: false,
        errorType: 'QUOTA_EXCEEDED',
        message: 'انتهت الحصة المجانية المؤقتة لـ Gemini API. يرجى الانتظار 45 ثانية والمحاولة مجدداً دون أي رسوم.',
        retryAfterSeconds: 45,
      });
    }

    return res.status(500).json({
      success: false,
      errorType: 'GENERATION_ERROR',
      message: `حدث خطأ أثناء التوليد الصوتي: ${errMsg.slice(0, 160)}`,
    });
  }
});

// Dual-speaker Interview Mode Endpoint
app.post('/api/tts/interview', async (req, res) => {
  try {
    const {
      turns,
      hostVoice = 'Fenrir',
      guestVoice = 'Charon',
      hostName = 'المقدم',
      guestName = 'الضيف',
      interviewStyle = 'لقاء إعلامي فاخر ورسمي',
    } = req.body;

    if (!Array.isArray(turns) || turns.length === 0) {
      return res.status(400).json({
        success: false,
        errorType: 'INVALID_INPUT',
        message: 'يجب تقديم حوار يحتوي على دورين على الأقل (المقدم والضيف).',
      });
    }

    let ai;
    try {
      ai = getAiClient();
    } catch {
      return res.status(500).json({
        success: false,
        errorType: 'MISSING_API_KEY',
        message: 'مفتاح GEMINI_API_KEY غير متوفر.',
      });
    }

    const allowedVoices = ['Fenrir', 'Charon', 'Puck', 'Zephyr', 'Kore'];
    const hostVoiceValid = allowedVoices.includes(hostVoice) ? hostVoice : 'Fenrir';
    // Ensure host and guest voices are distinct for natural dialogue contrast
    let guestVoiceValid = allowedVoices.includes(guestVoice) ? guestVoice : 'Charon';
    if (guestVoiceValid === hostVoiceValid) {
      guestVoiceValid = hostVoiceValid === 'Fenrir' ? 'Charon' : 'Fenrir';
    }

    // Build dialogue parts with speaker and style tags
    const parts = turns.map((turn: { speaker: string; text: string; style?: string }) => {
      const isHost = turn.speaker === hostName;
      const speakerId = isHost ? hostName : guestName;
      const baseStyle = isHost
        ? `Authoritative, poised broadcaster, deep baritone (${interviewStyle})`
        : `Refined guest, thoughtful, eloquent natural baritone`;
      const turnStyle = turn.style ? `${turn.style}, ${baseStyle}` : baseStyle;

      return {
        text: `${speakerId}: ${turn.text.trim()}`,
        speechMetadata: {
          speaker: speakerId,
        },
      } as any;
    });

    // gemini-3.8-flash-tts is the flagship model designed for dual-speaker screenplay
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-tts',
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: hostName,
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: hostVoiceValid },
                },
              },
              {
                speaker: guestName,
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: guestVoiceValid },
                },
              },
            ],
          },
        },
      },
    });

    const candidate = response.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData?.mimeType?.startsWith('audio/'));
    const base64Audio = audioPart?.inlineData?.data;

    if (!base64Audio) {
      return res.status(502).json({
        success: false,
        errorType: 'AUDIO_EXTRACTION_FAILED',
        message: 'لم يتم استخراج الصوت الثنائي بنجاح من النموذج.',
      });
    }

    return res.json({
      success: true,
      audioBase64: base64Audio,
      mimeType: audioPart?.inlineData?.mimeType || 'audio/wav',
      hostVoice: hostVoiceValid,
      guestVoice: guestVoiceValid,
      modelUsed: 'gemini-3.8-flash-tts',
    });
  } catch (error: any) {
    console.error('Error generating interview TTS:', error);
    const errMsg = String(error?.message || error);
    if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({
        success: false,
        errorType: 'QUOTA_EXCEEDED',
        message: 'تم استهلاك الحصة المجانية المؤقتة لـ Gemini API (429). يرجى الانتظار دقيقة والمحاولة ثانية.',
        retryAfterSeconds: 60,
      });
    }

    return res.status(500).json({
      success: false,
      errorType: 'GENERATION_ERROR',
      message: `حدث خطأ أثناء توليد الحوار: ${errMsg.slice(0, 160)}`,
    });
  }
});

// Text Enhancement Assistant Endpoint (Transforms text for optimal vocal delivery)
app.post('/api/text/enhance', async (req, res) => {
  try {
    const { text, mode = 'media' } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'النص فارغ.',
      });
    }

    let ai;
    try {
      ai = getAiClient();
    } catch {
      return res.status(500).json({
        success: false,
        message: 'مفتاح API غير متوفر.',
      });
    }

    let instruction = '';
    switch (mode) {
      case 'media':
        instruction = 'أعد صياغة النص بأسلوب إذاعي وتلفزيوني إعلامي فخم وواثق، مع الحفاظ على المعنى الأصلي تماماً، وضبط مخارج الحروف وعلامات الترقيم لتحقيق وقع رجالي قوي.';
        break;
      case 'documentary':
        instruction = 'حول النص إلى أسلوب سرد وثائقي سينمائي عالمي، يتميز بالعمق والمهابة والتشويق الرزين، مع فواصل درامية مناسبة دون تحريف المعنى.';
        break;
      case 'interview':
        instruction = 'أعد صياغة النص كجزء من حوار تلفزيوني رفيع المستوى، بلغة عفوية ولكن رزينة وأنيقة تناسب اللقاءات الحوارية.';
        break;
      case 'pauses':
        instruction = 'أضف علامات الوقف الطبيعية (مثل الفواصل، النقاط، وتوجيهات التنفس الخفيفة <breath> والوقفات الدرامية ...) لتنظيم إيقاع القراءة وجعل الإلقاء الصوتي طبيعياً ومريحاً.';
        break;
      case 'pronunciation':
        instruction = 'اضبط النص بالتشكيل الدقيق للكلمات التي قد يُساء نطقها، مع توضيح مخارج الحروف لضمان قراءة فصيحة لا تشوبها لكنة غير مرغوبة.';
        break;
      case 'iraqi':
        instruction = 'أعد صياغة النص بالأسلوب العراقي الإعلامي الراقي (لهجة بغدادية تلفزيونية فخمة ومثقفة كما في البرامج الوثائقية والحوارية العراقية الرصينة)، مع بقاء المعنى سليماً تماماً.';
        break;
      default:
        instruction = 'حسن النص ليكون جاهزاً للإلقاء الصوتي الرجالي الفخم بأفضل صورة ممكنة.';
    }

    let response;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `أنت خبير إلقاء صوتي وكتابة نصوص إذاعية وتلفزيونية فخمة.\nالمهمة: ${instruction}\n\nالنص الأصلي:\n"""\n${text}\n"""\n\nقم بإرجاع النص المحسن فقط دون أي مقدمات أو شروحات إضافية أو علامات اقتباس محيطة.`,
              },
            ],
          },
        ],
      });
    } catch (e: any) {
      console.warn('Text enhance fallback to gemini-3.1-flash-lite:', e.message || e);
      response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `أنت خبير إلقاء صوتي وكتابة نصوص إذاعية وتلفزيونية فخمة.\nالمهمة: ${instruction}\n\nالنص الأصلي:\n"""\n${text}\n"""\n\nقم بإرجاع النص المحسن فقط دون أي مقدمات أو شروحات إضافية أو علامات اقتباس محيطة.`,
              },
            ],
          },
        ],
      });
    }

    const enhancedText = response.text?.trim() || text;

    return res.json({
      success: true,
      enhancedText,
      mode,
    });
  } catch (error: any) {
    console.error('Error enhancing text:', error);
    const errMsg = String(error?.message || error);
    if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({
        success: false,
        message: 'الحصة المجانية المؤقتة لـ Gemini API مستنفذة حالياً. حاول بعد قليل.',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'تعذر تحسين النص حالياً.',
      details: errMsg,
    });
  }
});

// Setup Vite in Dev or Serve Static in Prod
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BARITONE AI studio server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
