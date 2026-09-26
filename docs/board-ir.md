# Board IR 规范（`webgpu-pin-layout/board@1`）

Board IR（Intermediate Representation，中间表示）是布局引擎的**输入格式**，与具体 EDA 格式无关。KiCad、你的自定义格式或其他工具，都先转换成 Board IR，再交给引擎；引擎输出 Placement 结果（见[第 9 节](#9-布局结果placement1)），由各自的适配器写回原格式。

```text
KiCad (.kicad_pcb) ──┐                                ┌──> 写回 KiCad
自定义格式 ──────────┼──> Board IR ──> 布局引擎 ──> Placement 结果 ──┼──> 写回自定义格式
其他 ────────────────┘                                └──> ...
```

- 机器可读的 JSON Schema：[`schema/board-ir.schema.json`](../schema/board-ir.schema.json)
- TypeScript 类型：[`src/ir/board-ir.d.ts`](../src/ir/board-ir.d.ts)
- 最小示例：[`examples/board-ir/minimal.board.json`](../examples/board-ir/minimal.board.json)
- 由真实 KiCad 板导出的完整示例：`node bench/kicad-to-ir.mjs <board.kicad_pcb> --out <file>.board.json`

## 目录

1. [约定](#1-约定)
2. [顶层结构](#2-顶层结构)
3. [几何类型](#3-几何类型)
4. [板子 `board`](#4-板子-board)
5. [网络 `nets`](#5-网络-nets)
6. [器件 `footprints`](#6-器件-footprints)
7. [区域、禁布区与模块](#7-区域禁布区与模块)
8. [规则 `rules` 与扩展 `extensions`](#8-规则-rules-与扩展-extensions)
9. [布局结果 `placement@1`](#9-布局结果placement1)
10. [校验规则](#10-校验规则)
11. [引擎如何使用 IR](#11-引擎如何使用-ir)
12. [版本与兼容](#12-版本与兼容)

每个字段都标注了当前引擎的支持状态：

| 标记 | 含义 |
|---|---|
| ✅ 已支持 | 引擎会使用该字段 |
| 🕓 预留 | 已纳入规范、校验器会检查，但当前引擎忽略它（会给出警告），将在后续版本实现 |
| ℹ️ 信息 | 只用于显示、统计或往返保存，不影响布局 |

---

## 1. 约定

### 1.1 单位

| 量 | 单位 |
|---|---|
| 长度、坐标、尺寸 | 毫米（mm），浮点数 |
| 角度 | 度（°），浮点数 |
| 面积（仅出现在统计信息中） | mm² |

### 1.2 坐标系

- **板坐标**：从板子**顶面**看过去的二维坐标，原点任意（通常沿用源格式的原点）。x 轴向右。
- **y 轴方向**由顶层字段 `yAxis` 声明：`"down"`（y 向下，KiCad、屏幕坐标采用这种）或 `"up"`（y 向上，Gerber、大多数机械 CAD 采用这种）。默认 `"down"`。整个文件里的所有坐标都必须使用同一种方向。
- **旋转角**按物理方向定义：**从板子顶面看，逆时针为正**。这个定义与 `yAxis` 无关，所以不会因为坐标轴方向不同而产生歧义。

### 1.3 器件局部坐标

每个器件（footprint）有自己的局部坐标系：

- 原点就是器件的**锚点**，可以是任意点（例如 KiCad 封装原点），`placement.x/y` 就是这个锚点在板上的位置；
- 焊盘位置、器件外形等都在局部坐标里给出，**表示器件放在顶面、旋转 0° 时，从顶面看到的样子**；
- 放到底面时由引擎负责镜像。**不要**把底面器件的焊盘预先镜像好再写进 IR。

### 1.4 局部坐标到板坐标的变换

设器件的摆放为 `placement = { x, y, rotation: θ, side }`，局部点为 `p = (px, py)`：

```text
world = (x, y) + R(θ) · M(side) · p

M(top)    = [ 1  0 ]         M(bottom) = [ -1  0 ]    （底面：沿局部 y 轴左右镜像，
            [ 0  1 ]                     [  0  1 ]      即从顶面看时的样子）

yAxis = "up"   时：R(θ) = [ cosθ  -sinθ ]
                          [ sinθ   cosθ ]

yAxis = "down" 时：R(θ) = [  cosθ   sinθ ]   （同一个物理旋转，
                          [ -sinθ   cosθ ]     y 轴取反后矩阵随之变化）
```

**例子**（`yAxis: "down"`）：局部点 `(1, 0)`，器件放在顶面 `(10, 20)`、旋转 90°，则 `world = (10, 20) + (0, -1) = (10, 19)`，也就是屏幕上的正上方，与“逆时针转 90°”一致。同一个器件放到底面、旋转 0° 时，局部点 `(1, 0)` 的板坐标是 `(9, 20)`。

> 从 KiCad 转换时要注意：`.kicad_pcb` 里底面封装的焊盘坐标**已经镜像过了**，所以写进 IR 之前要把局部 x 取反，恢复成顶面视角（`bench/kicad-to-ir.mjs` 已经这样处理）。

### 1.5 标识符

`id` 和 `name` 都是字符串。器件 `id`、网络 `name`、区域 `id`、模块 `id` 各自在自己的集合里必须唯一。区分大小写。

---

## 2. 顶层结构

```jsonc
{
  "format": "webgpu-pin-layout/board@1",  // 必填，固定值
  "yAxis": "down",                          // "down" | "up"，默认 "down"
  "name": "edk",                            // 可选，板名
  "source": { "tool": "kicad", "file": "edk.kicad_pcb" },   // 可选，ℹ️ 来源信息
  "board":      { ... },   // 必填，第 4 节
  "nets":       [ ... ],   // 必填，第 5 节（可为空数组）
  "footprints": [ ... ],   // 必填，第 6 节
  "regions":    [ ... ],   // 可选，第 7.1 节
  "keepouts":   [ ... ],   // 可选，第 7.2 节
  "modules":    [ ... ],   // 可选，第 7.3 节
  "rules":      { ... },   // 可选，第 8 节
  "extensions": { ... }    // 可选，第 8.2 节
}
```

---

## 3. 几何类型

所有 `Point` 都写成 `[x, y]` 两元素数组。

### 3.1 `Shape`

```jsonc
{ "type": "rect",    "x": 0, "y": 0, "width": 10, "height": 5 }   // 与坐标轴对齐；(x, y) 是 x、y 取值最小的那个角
{ "type": "circle",  "center": [5, 5], "radius": 2 }
{ "type": "polygon", "points": [[0,0], [10,0], [10,5], [0,5]],    // 首尾不必重复，顶点顺序任意
                     "holes": [ [[2,2], [3,2], [3,3]] ] }          // 可选，孔洞
```

- **多边形**必须是简单多边形（不能自相交）；孔洞必须完全位于外轮廓内部，且孔洞之间互不重叠。
- **圆弧和曲线**需要由导出方先离散成折线。建议弦高误差不超过 0.05 mm。

### 3.2 焊盘形状 `PadShape`

| `shape` | 必填字段 | 说明 |
|---|---|---|
| `"rect"` | `size: [w, h]` | 矩形 |
| `"roundrect"` | `size`，可选 `cornerRadius` | 圆角矩形 |
| `"oval"` | `size` | 长圆（两端为半圆） |
| `"circle"` | `size: [d, d]` | 圆形 |
| `"polygon"` | `points`（局部坐标，相对焊盘中心） | 自定义形状；另需给出 `size` 作为外接矩形 |

当前引擎统一按**外接矩形**处理焊盘（旋转后取轴对齐外接框），✅。精确形状 🕓 预留。

---

## 4. 板子 `board`

```jsonc
"board": {
  "outline": [                              // 必填：一个或多个板块（拼板时可以有多个）
    { "outer": [[0,0], [100,0], [100,80], [0,80]],
      "holes": [ [[40,30], [60,30], [60,50], [40,50]] ] }   // 可选：开窗、槽孔等
  ],
  "thickness": 1.6,                          // 可选，mm，ℹ️
  "sides": ["top", "bottom"],                // 可以放置器件的面，默认 ["top", "bottom"]
  "copperLayers": [                          // 可选；缺省时视为两层板 [top, bottom]
    { "name": "F.Cu",   "side": "top",    "type": "signal" },
    { "name": "In1.Cu",                   "type": "plane", "net": "GND" },
    { "name": "In2.Cu",                   "type": "signal" },
    { "name": "B.Cu",   "side": "bottom", "type": "signal" }
  ]
}
```

| 字段 | 类型 | 状态 | 说明 |
|---|---|---|---|
| `outline[].outer` | `Point[]` | ✅ | 板子外轮廓。轮廓之外禁止放置和布线（按精确形状光栅化，分辨率约为板子长边的 1/1024，在 0.1–0.5 mm 之间） |
| `outline[].holes` | `Point[][]` | ✅ | 板内开孔，禁止放置器件和布线 |
| `sides` | `("top"\|"bottom")[]` | ✅ | 只允许单面放置的板子写 `["top"]` |
| `copperLayers` | 数组，从顶层到底层排列 | ℹ️（评估布线器 🕓） | 层的 `type` 为 `"signal"`、`"plane"` 或 `"mixed"`；`plane` 层可以用 `net` 指明是哪个网络的平面 |

---

## 5. 网络 `nets`

```jsonc
"nets": [
  { "name": "SDA",   "class": "signal" },
  { "name": "CLK",   "class": "signal", "priority": 90 },
  { "name": "+3V3",  "class": "power" },
  { "name": "GND",   "class": "ground" },
  { "name": "TEST1", "class": "signal", "ignore": true }
]
```

| 字段 | 类型 | 默认 | 状态 | 说明 |
|---|---|---|---|---|
| `name` | string | 必填 | ✅ | 焊盘通过这个名字引用网络 |
| `class` | `"signal"` \| `"power"` \| `"ground"` | `"signal"` | ✅ | 见下文 |
| `priority` | 0–100 | 50 | ✅ | 布局时的网络权重：权重 = 0.2 + priority / 55。时钟、差分对、高速线可以调高 |
| `ignore` | bool | false | ✅ | 布局时完全忽略这个网络（例如测试点网络） |

**`class` 的作用**：

- `signal`：计入走线长度（HPWL）、拥塞和模块划分，评估布线器会去布它。
- `power` / `ground`：视为由平面或铺铜承载，**不**计入 HPWL，也不参与布线评估。引擎把小器件（引脚数少于 8 的器件，例如去耦电容）的电源引脚，动态地拉向同一网络上最近的 IC 引脚（引脚数不少于 8 的器件）。

如果你的格式里没有网络类别，适配器可以按名字推断：本仓库在 `bench/kicad-adapter.mjs` 里用的正则规则可以直接参考。

---

## 6. 器件 `footprints`

```jsonc
{
  "id": "U3",                         // 必填，唯一（通常是位号）
  "value": "STM32F103",               // 可选，ℹ️
  "library": "Package_QFP:LQFP-48",   // 可选，ℹ️；推断“机械件”时会参考
  "pads": [
    { "id": "1", "at": [-3.5, -2.75], "shape": "rect", "size": [1.2, 0.3], "rotation": 0,
      "type": "smd", "net": "SDA" },
    { "id": "49", "at": [0, 0], "shape": "rect", "size": [3, 3], "type": "smd", "net": "GND" },
    { "id": "MH", "at": [5, 5], "shape": "circle", "size": [3, 3], "type": "npth", "drill": 3 }
  ],
  "courtyard": { "type": "rect", "x": -4.8, "y": -4.8, "width": 9.6, "height": 9.6 },   // 可选
  "height": 1.6,                      // 可选，mm，器件高度
  "placement": { "x": 50.2, "y": 30.0, "rotation": 90, "side": "top" },
  "fixed": false,
  "allowedSides": ["top", "bottom"],
  "allowedRotations": [0, 90, 180, 270],
  "mechanical": false,
  "region": null
}
```

### 6.1 字段

| 字段 | 类型 | 默认 | 状态 | 说明 |
|---|---|---|---|---|
| `id` | string | 必填 | ✅ | 唯一标识，结果文件里用它回写 |
| `pads` | `Pad[]` | `[]` | ✅ | 见 6.2 节 |
| `courtyard` | `Shape`（局部坐标） | 焊盘外接框每边外扩 0.25 mm | ✅ 外接矩形 | 器件占用的区域。引擎取它的外接矩形作为器件本体 |
| `height` | mm | 0 | ✅ | 器件高度，配合禁布区的 `maxHeight`（限高区）使用 |
| `placement` | `Placement` | — | ✅ | 当前或初始摆放；`fixed: true` 时必填 |
| `fixed` | bool | false | ✅ | 为 true 时位置、角度、面都不变 |
| `allowedSides` | `("top"\|"bottom")[]` | `[placement.side ?? "top"]` | ✅ | 允许放的面；写两个面，引擎就可以自动选面。通孔器件建议只写一个面 |
| `allowedRotations` | 角度数组（90 的倍数） | `[0, 90, 180, 270]` | ✅ 部分支持 | 只列一个角度时，器件不旋转。🕓 列出两个或三个角度（例如 `[0, 180]`）时，当前引擎仍会允许全部四个方向，更细的子集约束会在后续版本实现 |
| `mechanical` | bool | 由引擎推断 | ✅ | 连接器、安装孔等位置由机械结构决定的器件。开启预放置时，它们会被固定在 `placement` 的位置 |
| `region` | 区域 `id` \| null | null | 🕓 | 器件必须落在指定区域内 |
| `value`、`library` | string | — | ℹ️ | 只用于显示；`library` 会参与机械件推断 |

`Placement` 的结构：

```jsonc
{ "x": 50.2, "y": 30.0, "rotation": 90, "side": "top" }   // side 默认 "top"
```

### 6.2 焊盘 `Pad`

| 字段 | 类型 | 默认 | 状态 | 说明 |
|---|---|---|---|---|
| `id` | string | 必填 | ✅ | 在同一器件内唯一（例如引脚号） |
| `at` | `Point` | 必填 | ✅ | 焊盘中心的局部坐标 |
| `shape`、`size`、`points`、`cornerRadius` | 见 3.2 节 | `size` 必填 | ✅ 外接矩形 | |
| `rotation` | 度 | 0 | ✅ | 相对器件的旋转角（**不是**板上的绝对角度） |
| `type` | `"smd"` \| `"through"` \| `"npth"` | `"smd"` | ✅ | `smd`：只占器件所在那一面；`through`：金属化通孔，两层都占，器件因此两面都占位；`npth`：非金属化孔，两层都是障碍 |
| `drill` | mm | — | ℹ️ | 孔径 |
| `net` | 网络 `name` \| null | null | ✅ | 焊盘所属网络；null 表示不连接，但仍然是布线障碍 |

同一个器件可以有多个焊盘连到同一个网络（例如多个 GND 引脚），这是允许的。

---

## 7. 区域、禁布区与模块

### 7.1 区域 `regions`

命名区域，供模块和器件引用。

```jsonc
"regions": [
  { "id": "RF", "shape": { "type": "rect", "x": 70, "y": 0, "width": 30, "height": 25 }, "sides": ["top"] }
]
```

| 字段 | 类型 | 状态 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 唯一 |
| `shape` | `Shape`（板坐标） | ✅ 仅 `rect` / 🕓 其他形状 | 当前引擎只支持矩形区域 |
| `sides` | 面的数组 | ℹ️ | 区域对哪些面生效，默认两面 |

### 7.2 禁布区 `keepouts`

```jsonc
"keepouts": [
  { "id": "antenna", "shape": { "type": "polygon", "points": [[80,0],[100,0],[100,15],[80,15]] },
    "sides": ["top", "bottom"],
    "rules": { "placement": true, "routing": true, "vias": true },
    "maxHeight": null }
]
```

| 字段 | 状态 | 说明 |
|---|---|---|
| `shape`、`sides` | ✅ | 禁布区形状（板坐标）和生效的面，默认两面 |
| `rules.placement` / `routing` | ✅ | 禁止放器件 / 禁止走线（评估布线器），默认都为 true |
| `rules.vias` | 🕓 | 禁止打过孔 |
| `maxHeight` | ✅ | 不为 null 时，只禁止 `height` 超过该值的器件（限高区）；限高区不影响布线 |

板框外、孔洞和禁布区统一光栅化为每一面的掩码，并预先计算求和面积表，任何器件压在禁区上的面积都能 O(1) 得到。打分器（计入越界惩罚项）、全局布局（被挡住的格子视为已占满，把器件推开）、合法化器（只在可用格子上找位置）和评估布线器都使用这同一份掩码。

### 7.3 模块 `modules`

一组应该放在一起的器件。模块可以由外部给出，也可以由引擎自动划分（Louvain 社区发现）后导出，用户修改后再导入。

```jsonc
"modules": [
  { "id": "psu", "name": "电源", "footprints": ["U5", "L1", "C20", "C21", "D3"],
    "side": "auto", "region": "PSU_AREA", "cohesion": 0.4 }
]
```

| 字段 | 类型 | 默认 | 状态 | 说明 |
|---|---|---|---|---|
| `id` | string | 必填 | ✅ | 唯一 |
| `name` | string | 同 `id` | ℹ️ | 显示名 |
| `footprints` | 器件 `id` 数组 | 必填 | ✅ | 每个器件最多属于一个模块；固定器件会被忽略 |
| `side` | `"auto"` \| `"top"` \| `"bottom"` | `"auto"` | ✅ | `top` / `bottom`：把模块内允许两面放置的贴片器件锁定在这一面。`auto`：只决定模块的初始面（优先顶面，顶面容量不够时整块挪到底面），之后 LNS 仍可以单独翻动其中的器件 |
| `region` | 区域 `id` \| null | null | ✅ 矩形区域 | 模块级布局时把模块放在区域中心；之后的全局布局、LNS 和合法化全程把成员限制在区域内。区域放不下某个器件时，该器件会就近放在区域外（布局统计里会计数） |
| `cohesion` | ≥ 0 | 0.4 | ✅ | 成员被拉向模块质心的力度 |

`bench/place-board.mjs --export-modules` 导出的独立模块文件（`webgpu-pin-layout/modules@1`）与这里的 `modules` 语义相同，只是区域直接内联为矩形。

---

## 8. 规则 `rules` 与扩展 `extensions`

### 8.1 规则

```jsonc
"rules": {
  "componentClearance": 0.2,     // mm：器件本体之间的最小间距               ✅
  "edgeClearance": 0.3,          // mm：器件到板框和孔洞边缘的最小距离          ✅
  "track": { "width": 0.2, "clearance": 0.2 },   // mm：评估布线器按线宽加间距确定网格节距  🕓（当前固定 0.4 mm）
  "via":   { "diameter": 0.6, "drill": 0.3 }     // mm                                    🕓
}
```

### 8.2 扩展

`extensions` 是一个对象，键建议用你的格式名，内容任意。引擎**不读取**它，但会原样保留，所以适配器可以把源格式里 IR 不认识的数据放进这里，写回时再取出。

器件、焊盘、网络、模块、区域、禁布区上也都允许有 `extensions` 字段，规则相同。

```jsonc
"extensions": { "myformat": { "revision": "B", "partNumbers": { "U3": "STM32F103C8T6" } } }
```

---

## 9. 布局结果（`placement@1`）

引擎的输出，也是适配器写回原格式的依据。

```jsonc
{
  "format": "webgpu-pin-layout/placement@1",
  "board": "edk",
  "yAxis": "down",                 // 与输入 IR 相同
  "placements": [
    { "footprint": "U3", "x": 50.2, "y": 30.0, "rotation": 90, "side": "top" },
    { "footprint": "C7", "x": 48.0, "y": 33.1, "rotation": 0,  "side": "bottom" }
  ],
  "modules": [ /* 实际使用的模块划分，结构同 7.3 节，可以直接作为下一轮的输入 */ ],
  "metrics": {                     // ℹ️ 结果统计
    "hpwl_mm": 1841.2,                          // 信号网络半周长线长总和（mm）
    "overlappingPairs": 0,                      // 同面重叠的器件对数（count）
    "cleanNets": 124, "routedNetsTotal": 124,   // 两层评估布线下干净布通的网络数（count）
    "runtime_s": 9.1                            // 布局耗时（s）
  }
}
```

- 每个未固定的器件都会出现在 `placements` 里；固定器件也会原样列出，方便适配器统一处理。
- `rotation` 按第 1.2 节的约定给出，当前取值总是 0、90、180、270 之一；固定器件保持输入时的角度。
- `x`、`y` 是器件**锚点**的板坐标（与输入的 `placement` 含义相同），不是器件本体的中心。

---

## 10. 校验规则

`src/ir/validate.js` 中的 `validateBoardIR(ir)` 会检查以下各项，并返回 `{ errors, warnings }`。有 error 时引擎拒绝运行，并一次性列出所有问题。

**错误（error）**

1. `format` 不是 `"webgpu-pin-layout/board@1"`；`yAxis` 不是 `"down"` 或 `"up"`。
2. 器件 `id`、网络 `name`、区域 `id`、模块 `id` 有重复；同一器件内焊盘 `id` 重复。
3. 焊盘引用了不存在的网络；模块或器件引用了不存在的区域；模块引用了不存在的器件；同一器件出现在多个模块中。
4. `fixed: true` 但没有 `placement`。
5. `allowedSides` 为空，或包含 `board.sides` 以外的面；`placement.side` 不在 `allowedSides` 里。
6. 焊盘 `size` 不是正数；`polygon` 少于 3 个顶点；`outline` 为空；出现非有限数值（NaN、Infinity）。
7. `priority` 不在 0–100 范围内；`cohesion` 为负数。

**警告（warning）**

1. 使用了标为 🕓 的字段（引擎会忽略），例如 `rules.track`、`rules.via`、禁布区的 `rules.vias`、器件的 `region`。
2. 没有 `placement` 的器件：引擎会随机给出初始位置。
3. `allowedRotations` 里有 0/90/180/270 以外的角度（会被忽略）。
4. 固定器件的 `placement.rotation` 不是 90 的倍数：引擎会把它的精确角度折算进局部坐标，结果中原样返回该角度。
5. 声明了但没有任何焊盘引用的网络。

---

## 11. 引擎如何使用 IR

这一节说明 IR 在当前引擎里被映射成什么，方便判断你的数据会得到怎样的处理。

| IR 内容 | 引擎中的表示 |
|---|---|
| 器件本体 | `courtyard` 的外接矩形；没有 `courtyard` 时取焊盘外接框每边外扩 0.25 mm |
| 可放置范围 | `outline` 的精确形状，扣除孔洞、`edgeClearance` 边距和禁布区（每一面一张掩码；限高区只作用于更高的器件） |
| 信号焊盘 | 引脚（pin），参与 HPWL、拥塞和模块划分 |
| 电源和地焊盘 | 不参与 HPWL；小器件的电源引脚与最近的 IC 引脚之间生成低权重的动态拉力 |
| `type: "through"` 的焊盘 | 器件被标记为 `twoSided`：在两面都占位 |
| `allowedSides` 包含两面 | 器件可以翻面（`sides: 'any'`），LNS 会尝试翻面移动 |
| `fixed` / `mechanical`（开启预放置时） | 固定器件 |
| 非 90° 倍数角度的固定器件 | 把角度折算进局部坐标，以 0° 参与计算 |
| `modules` | 先在模块级做一轮全局布局，再展开到器件，并加上模块内聚力；有 `region` 的模块，成员全程被限制在区域内 |
| `priority` | 网络权重 |

---

## 12. 版本与兼容

- `format` 字符串带主版本号。只新增可选字段、或者把 🕓 字段变为 ✅，都**不**提升主版本号；删除字段或改变字段语义时才会升级到 `board@2`。
- 引擎会忽略它不认识的字段（包括 `extensions` 之外的字段），并给出警告，不会报错。
- 适配器写 IR 时，建议始终写出 `yAxis`，以及每个器件的 `allowedSides`，不要依赖默认值。
