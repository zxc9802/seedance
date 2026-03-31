import { YUNWU_PROVIDER_ORDER, YUNWU_PROVIDERS } from './yunwuProviders'

const IMAGE_PROVIDER_NAME = readClientEnv('VITE_IMAGE_PROVIDER_NAME', 'nanobanana1')
const IMAGE_PROVIDER_SELECTOR_LABEL = readClientEnv('VITE_IMAGE_PROVIDER_SELECTOR_LABEL', 'nanobanana1')
const IMAGE_PROVIDER_VENDOR = readClientEnv('VITE_IMAGE_PROVIDER_VENDOR', 'Gemini Native')
const IMAGE_MODEL_ID = readClientEnv('VITE_IMAGE_MODEL_ID', 'gemini-3.1-flash-image-preview')
const IMAGE_MODEL_LABEL = readClientEnv('VITE_IMAGE_MODEL_LABEL', 'Gemini 3.1 Flash')
const IMAGE_MODEL_TAG = readClientEnv('VITE_IMAGE_MODEL_TAG', 'native')
const IMAGE_AGGREGATION_PROVIDER_NAME = readClientEnv('VITE_IMAGE_AGGREGATION_PROVIDER_NAME', 'nanobanana2')
const IMAGE_AGGREGATION_PROVIDER_SELECTOR_LABEL = readClientEnv('VITE_IMAGE_AGGREGATION_PROVIDER_SELECTOR_LABEL', 'nanobanana2')
const IMAGE_AGGREGATION_PROVIDER_VENDOR = readClientEnv('VITE_IMAGE_AGGREGATION_PROVIDER_VENDOR', 'AI Aggregation')
const IMAGE_AGGREGATION_MODEL_ID = readClientEnv('VITE_IMAGE_AGGREGATION_MODEL_ID', 'gemini-3.1-flash-image-preview')
const IMAGE_AGGREGATION_MODEL_LABEL = readClientEnv('VITE_IMAGE_AGGREGATION_MODEL_LABEL', 'Gemini 3.1 Flash')
const IMAGE_AGGREGATION_MODEL_TAG = readClientEnv('VITE_IMAGE_AGGREGATION_MODEL_TAG', 'aggregation')

const BASE_PROVIDERS = {
  veo: {
    id: 'veo',
    typeId: 'seedance',
    typeLabel: 'Seedance',
    selectorLabel: 'seedance2.0',
    name: 'Seedance 2.0',
    vendor: '聚合 API',
    color: '#2563eb',
    models: [
      { value: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0', tag: '已接入' },
    ],
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    resolutions: {
      default: ['480p'],
    },
    durations: [4, 5, 6, 8, 10, 12, 15],
    sampleCounts: [1],
    features: {
      generateAudio: true,
      negativePrompt: false,
      referenceImage: true,
      referenceVideo: true,
      referenceAudio: true,
      materialLibrary: true,
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
      aspectRatio: '9:16',
      resolution: '480p',
      duration: 5,
      sampleCount: 1,
      generateAudio: false,
      imageMaterialType: 'role',
    },
    materialTypes: [
      { value: 'role', label: '人物审核' },
      { value: 'object', label: '物品审核' },
      { value: 'scene', label: '场景审核' },
      { value: 'direct', label: '直接原图' },
    ],
  },
  ve31p: {
    id: 've31p',
    typeId: 'veo',
    typeLabel: 'Veo',
    selectorLabel: 'veo1',
    name: 'Veo',
    vendor: '聚合 API',
    color: '#7c3aed',
    models: [
      { value: 'VE3.1P', label: 'Veo 3.1', tag: '已接入' },
    ],
    aspectRatios: ['16:9', '9:16'],
    resolutions: {
      default: ['720p'],
    },
    durations: [4, 6, 8],
    sampleCounts: [1],
    features: {
      generateAudio: true,
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
      ref: 5,
    },
    defaults: {
      model: 'VE3.1P',
      aspectRatio: '16:9',
      resolution: '720p',
      duration: 6,
      sampleCount: 1,
    },
    imageMimeTypes: ['image/jpeg', 'image/png'],
    imageMimeTypeLabel: 'JPG/JPEG、PNG',
    imageMaxSizeMb: 20,
    referenceHelpText: 'Veo 3.1 参考图仅支持 JPG/JPEG、PNG，后端会先上传文件并转成公网可访问 URL，再按文档里的 resources 参数提交给模型。',
  },
  veo31fast: {
    id: 'veo31fast',
    typeId: 'veo',
    typeLabel: 'Veo',
    selectorLabel: 'veo2',
    name: 'Veo Fast',
    vendor: '聚合 API',
    color: '#e67e22',
    models: [
      { value: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast', tag: '新' },
    ],
    aspectRatios: ['16:9', '9:16'],
    resolutions: {
      default: ['720p'],
    },
    durations: [5, 8],
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
    referenceInputMode: 'base64',
    maxReferenceImages: {
      i2v: 1,
      flf: 2,
      ref: 5,
    },
    defaults: {
      model: 'veo-3.1-fast-generate-preview',
      aspectRatio: '16:9',
      resolution: '720p',
      duration: 5,
      sampleCount: 1,
    },
    imageMimeTypes: ['image/jpeg', 'image/png'],
    imageMimeTypeLabel: 'JPG/JPEG、PNG',
    imageMaxSizeMb: 20,
    referenceHelpText: 'Veo Fast 当前这条通道实测输出固定为 16:9。参考图前端会将图片转为 Base64 直接提交：首张图作为主图，其余图片作为参考图，仅支持 JPG/JPEG、PNG。',
  },
  kling: {
    id: 'kling',
    typeId: 'kling',
    typeLabel: 'Kling',
    selectorLabel: 'kling1',
    name: '可灵',
    vendor: '聚合 API',
    color: '#f97316',
    models: [
      { value: 'kling-v3-omni', label: 'Kling 3.1', tag: '已接入' },
    ],
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: {
      default: ['720p'],
    },
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    sampleCounts: [1],
    features: {
      generateAudio: true,
      negativePrompt: false,
      referenceImage: true,
      referenceVideo: true,
      referenceAudio: false,
    },
    generationModes: [
      { value: 'i2v', label: '首帧' },
      { value: 'flf', label: '首尾帧' },
      { value: 'ref', label: '参考图片' },
      { value: 'fusion', label: '参考生视频' },
    ],
    referenceInputMode: 'url',
    maxReferenceImages: {
      i2v: 1,
      flf: 2,
      ref: 7,
      fusion: 7,
    },
    maxReferenceVideos: {
      fusion: 1,
    },
    defaults: {
      model: 'kling-v3-omni',
      aspectRatio: '16:9',
      resolution: '720p',
      duration: 5,
      sampleCount: 1,
      generateAudio: true,
    },
    imageMimeTypes: ['image/jpeg', 'image/png'],
    imageMimeTypeLabel: 'JPG/JPEG、PNG',
    imageMaxSizeMb: 10,
    imageValidation: {
      minWidth: 300,
      minHeight: 300,
      minAspectRatio: 0.4,
      maxAspectRatio: 2.5,
      aspectRatioLabel: '1:2.5 ~ 2.5:1',
    },
    videoMimeTypes: ['video/mp4', 'video/quicktime'],
    videoMimeTypeLabel: 'MP4、MOV',
    videoMaxSizeMb: 200,
    videoValidation: {
      minDurationSec: 3,
      minWidth: 720,
      minHeight: 720,
      maxWidth: 2160,
      maxHeight: 2160,
    },
    referenceHelpText: '参考模式最多上传 7 张图片；如果带参考视频，图片最多 4 张且仅支持无声。参考视频仅支持 1 段 MP4/MOV，时长不少于 3 秒，文件不超过 200MB。',
  },
  wan1: {
    id: 'wan1',
    typeId: 'wan',
    typeLabel: '\u4e07\u8c61',
    selectorLabel: 'wan1',
    name: '\u4e07\u8c61',
    vendor: 'DashScope',
    color: '#0ea5e9',
    models: [
      { value: 'wan2.6-r2v-flash', label: 'Wan 2.6 R2V Flash', tag: 'DashScope' },
    ],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    resolutions: {
      default: ['720P'],
    },
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    sampleCounts: [1],
    features: {
      generateAudio: true,
      negativePrompt: true,
      referenceImage: true,
      referenceVideo: true,
      referenceAudio: false,
      watermark: true,
      shotType: true,
    },
    generationModes: [
      { value: 'fusion', label: '\u89d2\u8272\u53c2\u8003' },
    ],
    referenceInputMode: 'url',
    maxReferenceImages: {
      fusion: 5,
    },
    maxReferenceVideos: {
      fusion: 3,
    },
    defaults: {
      model: 'wan2.6-r2v-flash',
      aspectRatio: '16:9',
      resolution: '720P',
      duration: 5,
      sampleCount: 1,
      generateAudio: true,
      watermark: false,
      shotType: 'single',
      negativePrompt: '',
    },
    shotTypeOptions: [
      { value: 'single', label: '\u5355\u955c\u5934' },
      { value: 'multi', label: '\u591a\u955c\u5934' },
    ],
    imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'],
    imageMimeTypeLabel: 'JPG/JPEG\u3001PNG\u3001WebP\u3001BMP',
    imageMaxSizeMb: 10,
    imageValidation: {
      minWidth: 240,
      minHeight: 240,
    },
    videoMimeTypes: ['video/mp4', 'video/quicktime'],
    videoMimeTypeLabel: 'MP4\u3001MOV',
    videoMaxSizeMb: 100,
    videoValidation: {
      minDurationSec: 1,
    },
    referenceHelpText: '\u89d2\u8272\u7ed1\u5b9a\u987a\u5e8f\u4f1a\u6309\u7167\u56fe\u7247/\u89c6\u9891\u7684\u6dfb\u52a0\u987a\u5e8f\u751f\u6548\uff0c\u8bf7\u6309 character1\u3001character2 \u9700\u8981\u7684\u987a\u5e8f\u4e0a\u4f20\u53c2\u8003\u7d20\u6750\u3002',
    backendKind: 'dashscope-wan',
  },
  'gemini-image': {
    id: 'gemini-image',
    typeId: 'image',
    typeLabel: 'Image',
    selectorLabel: IMAGE_PROVIDER_SELECTOR_LABEL,
    name: IMAGE_PROVIDER_NAME,
    vendor: IMAGE_PROVIDER_VENDOR,
    color: '#10a37f',
    outputType: 'image',
    models: [
      { value: IMAGE_MODEL_ID, label: IMAGE_MODEL_LABEL, tag: IMAGE_MODEL_TAG },
    ],
    aspectRatios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
    resolutions: { default: ['512', '1K', '2K', '4K'] },
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
      model: IMAGE_MODEL_ID,
      aspectRatio: '1:1',
      resolution: '1K',
      sampleCount: 1,
    },
    backendKind: 'openai-image',
  },
  'gemini-image-aggregation': {
    id: 'gemini-image-aggregation',
    typeId: 'image',
    typeLabel: 'Image',
    selectorLabel: IMAGE_AGGREGATION_PROVIDER_SELECTOR_LABEL,
    name: IMAGE_AGGREGATION_PROVIDER_NAME,
    vendor: IMAGE_AGGREGATION_PROVIDER_VENDOR,
    color: '#ef4444',
    outputType: 'image',
    models: [
      {
        value: IMAGE_AGGREGATION_MODEL_ID,
        label: IMAGE_AGGREGATION_MODEL_LABEL,
        tag: IMAGE_AGGREGATION_MODEL_TAG,
      },
    ],
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '1:8', '4:1', '8:1'],
    resolutions: {
      default: ['512', '1K', '2K'],
    },
    durations: [],
    sampleCounts: [1],
    features: {
      generateAudio: false,
      negativePrompt: false,
      referenceImage: true,
    },
    maxReferenceImages: 14,
    defaults: {
      model: IMAGE_AGGREGATION_MODEL_ID,
      aspectRatio: '9:16',
      resolution: '1K',
      sampleCount: 1,
    },
    referenceHelpText: 'Supports text-to-image and multi-image generation. The backend uploads references first and sends their URLs in payload.resources. Up to 14 reference images.',
    backendKind: 'aggregation-image',
  },
}

export const PROVIDERS = {
  ...BASE_PROVIDERS,
  ...YUNWU_PROVIDERS,
}

const BASE_PROVIDER_ORDER = ['veo', 've31p', 'veo31fast', 'kling', 'wan1', 'gemini-image', 'gemini-image-aggregation']

export const PROVIDER_ORDER = [...BASE_PROVIDER_ORDER, ...YUNWU_PROVIDER_ORDER]

export const MODEL_TYPES = PROVIDER_ORDER.reduce((acc, providerId) => {
  const config = PROVIDERS[providerId]
  const typeId = config.typeId || providerId

  if (!acc[typeId]) {
    acc[typeId] = {
      id: typeId,
      label: config.typeLabel || config.name,
      outputType: config.outputType || 'video',
      providers: [],
    }
  }

  acc[typeId].providers.push(providerId)
  return acc
}, {})

export const MODEL_TYPE_ORDER = Object.keys(MODEL_TYPES)

function readClientEnv(name, fallback) {
  const value = import.meta.env?.[name]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
