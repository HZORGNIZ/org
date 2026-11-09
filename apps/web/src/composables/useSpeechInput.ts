import { onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

/**
 * Web Speech API 语音录入（Chrome/Edge 原生中文识别，无需后端）
 * 识别结果实时追加到目标文本框末尾（以已有内容为起点），松开即停；
 * 只负责"把话变成字"，要不要发送由调用方决定（用户常要先补时间/人名再发）。
 */
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export function useSpeechInput(getText: () => string, setText: (text: string) => void) {
  const srSupported =
    typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const listening = ref(false);
  let recognition: SpeechRecognitionLike | null = null;
  let confirmedText = ''; // 已确认文本（final）
  let interimBuffer = ''; // 中间结果（松开时补入，避免丢字）
  let stopTimer: any = null;

  /** 结束时总要把中间结果补进正文，否则最后一句话会丢字 */
  function finish() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    listening.value = false;
    if (interimBuffer) {
      confirmedText += interimBuffer;
      interimBuffer = '';
      setText(confirmedText);
    }
  }

  function start() {
    if (!srSupported || listening.value) return;
    // 上一轮 stop 的兜底计时器还没到时又开说：先取消，否则会把这一轮的状态打掉
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    recognition = new SR() as SpeechRecognitionLike;
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    confirmedText = getText(); // 以当前输入为起点继续追加
    interimBuffer = '';
    recognition.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) confirmedText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      interimBuffer = interim;
      setText(confirmedText + interim);
    };
    recognition.onerror = (e: any) => {
      finish();
      const tips: Record<string, string> = {
        'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试',
        'service-not-allowed': '浏览器/网络不支持语音服务，请改用 Edge 浏览器重试',
        network: '语音服务连接失败（Chrome 在国内网络下不可用），请改用 Edge 浏览器',
        'no-speech': '没有听到声音，请靠近麦克风再说',
        'audio-capture': '未检测到麦克风设备，请检查设备连接',
      };
      ElMessage.warning('语音识别出错：' + (tips[e.error] || e.error));
    };
    recognition.onend = () => {
      // 松开停止时补上未确认的中间文本，避免丢字
      finish();
    };
    try {
      recognition.start();
      listening.value = true;
    } catch {
      // 浏览器拒绝重复 start（连点/权限弹窗未处理完）时不弹窗打扰，静默恢复按钮
      listening.value = false;
    }
  }

  function stop() {
    if (!listening.value) return;
    recognition?.stop();
    // 兜底：识别尚未真正 start（权限弹窗未处理 / 国内 Chrome 连不上语音服务）时浏览器不会回调 onend，
    // 按钮会一直卡在"聆听中"，这里 1.2s 后强制复位
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (listening.value) finish();
    }, 1200);
  }

  // 面板收起 / 切页时别让麦克风一直开着
  onUnmounted(() => {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
    listening.value = false;
    recognition?.stop?.();
  });

  return { srSupported, listening, start, stop };
}
