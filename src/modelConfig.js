export const PROVIDERS = {
  veo: {
    id: 'veo',
    name: 'Seedance 2.0',
    vendor: '聚合 API',
    color: '#2563eb',
    models: [
      { value: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0', tag: '已接入' },
    ],
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    resolutions: {
      default: ['480p', '720p', '1080p'],
    },
    durations: [4, 5, 6, 8, 10, 12, 15],
    sampleCounts: [1],
    features: {
      generateAudio: true,
      negativePrompt: false,
      referenceImage: true,
      referenceVideo: true,
      referenceAudio: true,
    },
    generationModes: [
      { value: 't2v', label: '文生视频' },
      { value: 'i2v', label: '图生视频' },
      { value: 'flf', label: '首尾帧' },
      { value: 'fusion', label: '融合参考' },
    ],
    referenceInputMode: 'url',
    maxReferenceImages: {
      t2v: 0,
      i2v: 1,
      flf: 2,
      fusion: 9,
    },
    maxReferenceVideos: {
      fusion: 3,
    },
    maxReferenceAudios: {
      fusion: 3,
    },
    defaults: {
      model: 'doubao-seedance-2-0-260128',
      aspectRatio: '16:9',
      resolution: '720p',
      duration: 5,
      sampleCount: 1,
      generateAudio: false,
    },
  },
  ve31p: {
    id: 've31p',
    name: 'Veo',
    vendor: '聚合 API',
    color: '#7c3aed',
    models: [
      { value: 'VE3.1P', label: 'Veo 3.1', tag: '已接入' },
    ],
    aspectRatios: ['16:9', '9:16'],
    resolutions: {
      default: ['720p', '1080p'],
    },
    durations: [4, 6, 8],
    sampleCounts: [1],
    features: {
      generateAudio: false,
      negativePrompt: false,
      referenceImage: true,
      referenceVideo: false,
      referenceAudio: false,
    },
    generationModes: [
      { value: 'i2v', label: '首帧' },
      { value: 'flf', label: '首尾帧' },
      { value: 'ref', label: '参考图片' },
    ],
    referenceInputMode: 'url',
    maxReferenceImages: {
      i2v: 1,
      flf: 2,
      ref: 3,
    },
    defaults: {
      model: 'VE3.1P',
      aspectRatio: '16:9',
      resolution: '720p',
      duration: 6,
      sampleCount: 1,
    },
  },
  'gemini-image': {
    id: 'gemini-image',
    name: '绘图',
    vendor: 'Google',
    color: '#10a37f',
    outputType: 'image',
    models: [
      { value: 'gemini-3.1-flash-image-preview', label: 'Gemini 3.1 Flash', tag: '最新' },
    ],
    aspectRatios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
    resolutions: { default: [] },
    durations: [],
    sampleCounts: [1],
    features: {
      generateAudio: false,
      negativePrompt: false,
      referenceImage: true,
    },
    maxReferenceImages: 5,
    promptTemplates: [
      {
        id: 'three-view',
        emoji: '📦',
        title: '产品三视图',
        prompt: 'Professional product photography showing three views of the product: front view, side view, and back view, arranged in a triptych layout on a clean white background, studio lighting, ultra-detailed, 8K',
      },
      {
        id: 'white-bg',
        emoji: '🧾',
        title: '产品白底图',
        prompt: 'Product photography on pure white background, professional e-commerce style, clean studio lighting, high resolution, centered composition, no shadows',
      },
      {
        id: 'social-ad',
        emoji: '🪧',
        title: '社媒广告图',
        prompt: 'Eye-catching social media advertisement banner, vibrant colors, modern design, trending aesthetic, professional marketing photo, dynamic composition',
      },
      {
        id: 'cartoon',
        emoji: '🎨',
        title: '卡通风格',
        prompt: '把这张图转换成卡通风格，高清',
      },
      {
        id: 'ghibli',
        emoji: '🌅',
        title: '吉卜力风格',
        prompt: '把这张图转换成吉卜力动画风格，柔和的色彩，手绘质感，宫崎骏风格，高清',
      },
      {
        id: 'oil-painting',
        emoji: '🖼️',
        title: '油画风格',
        prompt: '把这张图转换成经典油画风格，浓郁的色彩，厚重的笔触，艺术质感，高清',
      },
    ],
    defaults: {
      model: 'gemini-3.1-flash-image-preview',
      aspectRatio: '1:1',
      sampleCount: 1,
    },
  },
}

export const PROVIDER_ORDER = ['veo', 've31p', 'gemini-image']
