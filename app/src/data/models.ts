export interface CellModel {
  id: string;
  name: string;
  subtitle: string;
  category: string;
  description: string;
  size: string;
  location: string;
  visibleInLM: string;
  accent: string;
  features: { name: string; detail: string }[];
  funFact: string;
  whereItOccurs: {
    text: string;
    habitat: string;
  };
  concepts?: {
    term: string;
    level: '初中' | '高中';
    explanation: string;
    visualHint: string;
  }[];
  modelUrl: string;
  imageUrl: string;
  /** 经过 Draco 压缩后的真实文件大小（字节），用于估算下载进度 */
  fileSize: number;
  /** 默认绕 Y 轴的旋转角度（弧度）；用于让模型呈现合适的视角 */
  defaultRotationY: number;
  /** 在统一归一化尺寸基础上的显示倍率，用于让不同模型默认呈现大小不同 */
  displayScale: number;
  /** 是否为运行时新增模型 */
  custom?: boolean;
  /** 生成或导入来源 */
  source?: string;
  /** 当前生成/导入状态说明 */
  generationStatus?: string;
}

const BASE = import.meta.env.BASE_URL;
const asset = (p: string) => `${BASE}${p}`.replace(/\/+/g, '/');

export const MODELS: CellModel[] = [
  {
    id: 'plant-cell',
    name: '植物细胞',
    subtitle: '真核细胞 · 自养生物',
    category: '真核细胞',
    accent: '#7fb069',
    description:
      '植物细胞是构成植物体的基本单位。与动物细胞不同，它拥有坚硬的细胞壁、能进行光合作用的叶绿体，以及储存营养与水分的大型液泡，使其既能保持形态又能为整个生态系统提供能量。',
    size: '10 – 100 微米',
    location: '植物的根、茎、叶、花、果实',
    visibleInLM: '是',
    features: [
      { name: '细胞壁', detail: '由纤维素构成，提供形态支撑与机械保护' },
      { name: '叶绿体', detail: '光合作用场所，将光能转化为有机物' },
      { name: '大液泡', detail: '储存水分、糖、色素，维持膨压' },
      { name: '细胞核', detail: '储存遗传信息，调控代谢与分裂' },
      { name: '线粒体', detail: '细胞的能量工厂，进行有氧呼吸' },
      { name: '内质网与高尔基体', detail: '蛋白质合成、加工与运输' },
    ],
    funFact:
      '叶肉细胞把光收进叶绿体，把水与二氧化碳慢慢写成糖。一片叶子，也是一间安静工作的能量作坊。',
    whereItOccurs: {
      text: '从苔藓到参天大树，植物细胞无处不在地构筑着大地的绿色。',
      habitat: '陆生植物 · 水生藻类 · 蕨类',
    },
    concepts: [
      {
        term: 'ATP',
        level: '高中',
        explanation: '细胞临时储存和转移能量的小分子，像一枚可以反复充放电的能量硬币。',
        visualHint: '光能 -> 葡萄糖 -> ATP -> 生命活动',
      },
      {
        term: '光合作用',
        level: '初中',
        explanation: '叶绿体利用光能，把二氧化碳和水合成有机物，同时释放氧气。',
        visualHint: '光 + CO2 + H2O -> 糖 + O2',
      },
    ],
    modelUrl: asset('models/plant-cell.glb'),
    imageUrl: asset('images/plant-cell.jpg'),
    fileSize: 6030628,
    defaultRotationY: -Math.PI / 4,
    displayScale: 1.28,
  },
  {
    id: 'animal-cell',
    name: '动物细胞',
    subtitle: '真核细胞 · 异养生物',
    category: '真核细胞',
    accent: '#e8859a',
    description:
      '动物细胞缺少细胞壁和叶绿体，依赖灵活的细胞膜与丰富的细胞器协作完成代谢与运动。从你正在跳动的心肌细胞到大脑皮层中的胶质细胞，它们以惊人的多样性塑造着复杂的生命体。',
    size: '10 – 30 微米',
    location: '所有动物的组织与器官',
    visibleInLM: '是',
    features: [
      { name: '细胞膜', detail: '磷脂双分子层，选择性地控制物质进出' },
      { name: '细胞核', detail: '遗传中心，包含 DNA 与核仁' },
      { name: '线粒体', detail: '产生 ATP，被称为「细胞的电厂」' },
      { name: '内质网', detail: '粗面合成蛋白质，光面合成脂质' },
      { name: '高尔基体', detail: '蛋白质的加工与分拣中心' },
      { name: '溶酶体', detail: '细胞的「回收站」，分解代谢废物' },
    ],
    funFact:
      '一个成年人体内大约有 37 万亿个细胞——它们每一秒都在协作，构成你正在阅读这段文字的「你」。',
    whereItOccurs: {
      text: '从单细胞原生动物到鲸鱼，所有动物的身体都是由动物细胞组成。',
      habitat: '哺乳动物 · 鱼类 · 昆虫 · 鸟类',
    },
    concepts: [
      {
        term: 'ATP',
        level: '高中',
        explanation: '线粒体把营养物质中的能量转移到 ATP 中，供肌肉收缩、物质运输等活动使用。',
        visualHint: '葡萄糖 + O2 -> ATP + CO2 + H2O',
      },
      {
        term: '细胞膜',
        level: '初中',
        explanation: '细胞膜像边界和门卫，既保护细胞，也选择性地控制物质进出。',
        visualHint: '外界物质 <-> 细胞膜 <-> 细胞内部',
      },
    ],
    modelUrl: asset('models/animal-cell.glb'),
    imageUrl: asset('images/animal-cell.jpg'),
    fileSize: 10673912,
    defaultRotationY: -Math.PI / 4,
    displayScale: 1.26,
  },
  {
    id: 'white-blood-cell',
    name: '白细胞',
    subtitle: '免疫细胞 · 身体的卫士',
    category: '免疫细胞',
    accent: '#c8a2d8',
    description:
      '白细胞是免疫系统的核心成员，巡逻在血液与淋巴中。它们能够识别入侵的病原体，通过吞噬、释放细胞因子或精准杀伤的方式守护机体的稳态。',
    size: '6 – 20 微米',
    location: '血液、淋巴系统、骨髓',
    visibleInLM: '是',
    features: [
      { name: '不规则的细胞核', detail: '不同亚型呈分叶或马蹄形' },
      { name: '细胞膜与伪足', detail: '可主动变形，穿越毛细血管壁' },
      { name: '吞噬泡', detail: '包裹并消化入侵的细菌或异物' },
      { name: '颗粒体', detail: '储存酶与抗菌肽，释放后清除病原' },
      { name: '线粒体', detail: '提供免疫反应所需的能量' },
    ],
    funFact:
      '一个健康成年人每天会生成约 1000 亿个新的白细胞，几乎是地球总人口的十二倍。',
    whereItOccurs: {
      text: '每一滴血液里，都游弋着千万个白细胞，全天候巡逻你的身体。',
      habitat: '血液 · 骨髓 · 脾脏 · 淋巴结',
    },
    concepts: [
      {
        term: '吞噬作用',
        level: '初中',
        explanation: '部分白细胞会包围并吞入病原体，再用细胞内的酶将其分解。',
        visualHint: '识别 -> 包围 -> 吞入 -> 分解',
      },
      {
        term: '免疫应答',
        level: '高中',
        explanation: '免疫细胞通过识别抗原、传递信号和清除目标，帮助身体维持稳态。',
        visualHint: '抗原 -> 白细胞 -> 免疫信号 -> 清除',
      },
    ],
    modelUrl: asset('models/white-blood-cell.glb'),
    imageUrl: asset('images/white-blood-cell.jpg'),
    fileSize: 10812336,
    defaultRotationY: -Math.PI / 4,
    displayScale: 1.24,
  },
  {
    id: 'neuron',
    name: '神经元',
    subtitle: '可兴奋细胞 · 信息传递者',
    category: '神经细胞',
    accent: '#f0a868',
    description:
      '神经元是信息处理的基本单元。突出的树突像天线一样接收信号，长长的轴突则把电脉冲送往远方。它们用化学和电的语言编织出感知、记忆与思考。',
    size: '细胞体 4 – 100 微米，轴突可达 1 米',
    location: '大脑、脊髓、周围神经系统',
    visibleInLM: '是（须染色）',
    features: [
      { name: '细胞体', detail: '包含核与主要细胞器，整合输入信号' },
      { name: '树突', detail: '分支繁多，接收来自其他神经元的信号' },
      { name: '轴突', detail: '传导电脉冲，可延伸至身体远端' },
      { name: '髓鞘', detail: '加快传导速度，由施旺细胞或少突胶质细胞包裹' },
      { name: '突触', detail: '通过神经递质把信号传递给下一个细胞' },
    ],
    funFact:
      '人脑约有 860 亿个神经元，它们之间的连接数超过银河系恒星总数。',
    whereItOccurs: {
      text: '从蝴蝶的复眼到人类的大脑皮层，神经元让动物拥有了感觉与思考的能力。',
      habitat: '中枢神经系统 · 周围神经 · 感觉器官',
    },
    concepts: [
      {
        term: '神经冲动',
        level: '高中',
        explanation: '神经元膜两侧电位变化形成电信号，沿轴突快速传递到远端。',
        visualHint: '刺激 -> 电位变化 -> 轴突传导 -> 突触',
      },
      {
        term: '突触',
        level: '高中',
        explanation: '一个神经元通过突触释放神经递质，把信息传给下一个细胞。',
        visualHint: '电信号 -> 递质 -> 受体 -> 新信号',
      },
    ],
    modelUrl: asset('models/neuron.glb'),
    imageUrl: asset('images/neuron.jpg'),
    fileSize: 7359744,
    defaultRotationY: -Math.PI / 4,
    displayScale: 1.36,
  },
  {
    id: 'dna',
    name: 'DNA 双螺旋',
    subtitle: '遗传分子 · 生命的蓝图',
    category: '生物大分子',
    accent: '#9cc4e4',
    description:
      'DNA 由两条互补的核苷酸链组成，盘旋成优雅的双螺旋。它把生命的指令写成 A、T、G、C 四个字母，让信息得以在亿万年之间一代代地复制、表达与演化。',
    size: '直径约 2 纳米，长度因物种而异',
    location: '细胞核、线粒体、叶绿体',
    visibleInLM: '仅电镜可见',
    features: [
      { name: '双螺旋骨架', detail: '由磷酸与脱氧核糖交替连接而成' },
      { name: '碱基对', detail: 'A 与 T、G 与 C 通过氢键互补配对' },
      { name: '大沟与小沟', detail: '蛋白质识别 DNA 的关键结构' },
      { name: '半保留复制', detail: '每一次复制都保留一条母链作模板' },
    ],
    funFact:
      '把一个细胞里的 DNA 拉成直线约有 2 米长；全身细胞的 DNA 接起来可往返太阳数百次。',
    whereItOccurs: {
      text: '从最古老的细菌到你身上的每一个细胞，DNA 都在静静守护着生命的密码。',
      habitat: '细菌 · 古菌 · 真核生物 · 病毒（部分）',
    },
    concepts: [
      {
        term: '碱基互补配对',
        level: '高中',
        explanation: 'DNA 中 A 总与 T 配对，G 总与 C 配对，这是复制和转录准确进行的基础。',
        visualHint: 'A-T / G-C',
      },
      {
        term: '遗传信息',
        level: '初中',
        explanation: 'DNA 上的碱基排列顺序记录遗传信息，指导生物体形成和维持生命活动。',
        visualHint: '碱基顺序 -> 蛋白质 -> 性状',
      },
    ],
    modelUrl: asset('models/dna.glb'),
    imageUrl: asset('images/dna.jpg'),
    fileSize: 9977020,
    defaultRotationY: 0,
    displayScale: 1.22,
  },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

const GENERATION_TEMPLATES: Record<string, CellModel> = {
  mitochondrion: {
    ...MODELS[0],
    id: 'mitochondrion',
    name: '线粒体',
    subtitle: '双层膜细胞器 · 能量转换',
    category: '细胞器',
    accent: '#d8844c',
    description:
      '线粒体通过有氧呼吸把有机物中的能量转移到 ATP 中。它有外膜、内膜和向内折叠的嵴，嵴能扩大反应面积，是理解细胞能量供应的核心结构。',
    size: '约 0.5 – 10 微米',
    location: '多数真核细胞的细胞质中',
    visibleInLM: '一般不可清晰分辨',
    features: [
      { name: '外膜', detail: '包裹线粒体，维持整体边界' },
      { name: '内膜', detail: '高度折叠形成嵴，是能量转换关键区域' },
      { name: '嵴', detail: '增加膜面积，容纳呼吸链相关蛋白' },
      { name: '基质', detail: '含酶、线粒体 DNA 和核糖体' },
      { name: 'ATP 合成', detail: '将能量临时储存在 ATP 分子中' },
    ],
    funFact: '肌肉细胞和神经细胞耗能很高，常常含有更多线粒体来维持持续活动。',
    whereItOccurs: {
      text: '从叶肉细胞到心肌细胞，线粒体把营养中的能量整理成可被细胞直接调用的 ATP。',
      habitat: '动物细胞 · 植物细胞 · 真菌细胞',
    },
    concepts: [
      {
        term: 'ATP',
        level: '高中',
        explanation: 'ATP 是细胞内直接供能物质，水解释放的能量可驱动主动运输、肌肉收缩和物质合成。',
        visualHint: '有机物 -> 呼吸作用 -> ATP -> 生命活动',
      },
      {
        term: '有氧呼吸',
        level: '高中',
        explanation: '细胞利用氧气分解有机物，释放能量并生成二氧化碳和水。',
        visualHint: '葡萄糖 + O2 -> CO2 + H2O + ATP',
      },
    ],
    defaultRotationY: -Math.PI / 5,
    displayScale: 1.18,
  },
  chloroplast: {
    ...MODELS[0],
    id: 'chloroplast',
    name: '叶绿体',
    subtitle: '光合作用细胞器 · 绿色能量入口',
    category: '细胞器',
    accent: '#6fa55d',
    description:
      '叶绿体含有叶绿素，能够吸收光能并参与光合作用。内部的类囊体堆叠成基粒，为光反应提供更大的膜面积。',
    size: '约 4 – 10 微米',
    location: '植物叶肉细胞和部分藻类细胞中',
    visibleInLM: '是',
    features: [
      { name: '双层膜', detail: '包裹叶绿体，隔开细胞质与内部反应空间' },
      { name: '类囊体', detail: '扁平膜囊，含叶绿素和光反应蛋白' },
      { name: '基粒', detail: '类囊体堆叠结构，增大光反应面积' },
      { name: '基质', detail: '含多种酶，参与碳反应合成有机物' },
    ],
    funFact: '一片成熟的叶子里可能含有数百万个叶绿体，它们把阳光慢慢转化为糖。',
    whereItOccurs: {
      text: '从苔藓到参天大树，叶绿体让绿色植物把光变成可储存的化学能。',
      habitat: '叶肉组织 · 藻类 · 幼嫩茎表皮',
    },
    concepts: [
      {
        term: '光合作用',
        level: '初中',
        explanation: '绿色植物利用光能，把二氧化碳和水合成有机物，同时释放氧气。',
        visualHint: '光 + CO2 + H2O -> 糖 + O2',
      },
      {
        term: '叶绿素',
        level: '初中',
        explanation: '叶绿素能吸收光能，是叶片呈绿色和进行光合作用的重要原因。',
        visualHint: '光能 -> 叶绿素 -> 化学能',
      },
    ],
    defaultRotationY: -Math.PI / 6,
    displayScale: 1.16,
  },
  bacterium: {
    ...MODELS[0],
    id: 'bacterium',
    name: '细菌',
    subtitle: '原核生物 · 单细胞生命',
    category: '原核细胞',
    accent: '#5b9aa8',
    description:
      '细菌通常没有成形细胞核，遗传物质集中在拟核区域。它们结构相对简单，却能在土壤、水体和人体内形成多样生态功能。',
    size: '约 0.5 – 5 微米',
    location: '土壤、水体、空气、动植物体表和体内',
    visibleInLM: '是（须染色）',
    features: [
      { name: '细胞壁', detail: '维持形态并提供保护' },
      { name: '细胞膜', detail: '控制物质进出并参与部分代谢' },
      { name: '拟核', detail: 'DNA 集中区域，没有核膜包裹' },
      { name: '核糖体', detail: '进行蛋白质合成' },
      { name: '鞭毛或菌毛', detail: '帮助运动或附着在表面' },
    ],
    funFact: '不是所有细菌都会致病，很多细菌参与分解有机物、固氮或维持肠道微生态。',
    whereItOccurs: {
      text: '细菌把不可见的微小活动铺满世界，从腐殖质分解到人体消化，它们一直在场。',
      habitat: '土壤 · 水体 · 肠道 · 植物根际',
    },
    concepts: [
      {
        term: '原核细胞',
        level: '初中',
        explanation: '没有成形细胞核的细胞，DNA 不被核膜包裹。',
        visualHint: '细胞壁 / 细胞膜 / 拟核 / 核糖体',
      },
      {
        term: '分解者',
        level: '初中',
        explanation: '许多细菌能分解动植物遗体和排泄物，促进物质循环。',
        visualHint: '有机残体 -> 细菌分解 -> 无机物',
      },
    ],
    defaultRotationY: -Math.PI / 4,
    displayScale: 1.12,
  },
};

export function getModelTemplate(templateId?: string): CellModel {
  return MODELS.find((model) => model.id === templateId) ?? GENERATION_TEMPLATES[String(templateId || '')] ?? MODELS[0];
}
