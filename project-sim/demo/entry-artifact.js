// 아티팩트 진입점: 링크 데모 + 관리자(GM) 패널
import { LocalNet } from "./local-net.js";
import { FX } from "./fx-registry.js";
import { installGmPanel } from "./gm-panel.js";
globalThis.__FX_REGISTRY = FX;
globalThis.__LOCAL_NET = LocalNet;
installGmPanel();
await import("../public/js/main.js");
