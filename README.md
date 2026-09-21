印刷拼版系统
============

零依赖 Node.js + 原生前端。核心拼版算法在 `lib/imposition.js`（浏览器与服务端共用同一份），
服务端 `server.js` 提供 REST API 并把状态原子落盘到 `data/state.json`。

运行
----

    npm start          # http://localhost:8080
    npm test           # node:test 单元测试（9 个）

概念
----

- 拼版区 = 纸张幅面 − 咬口条；每件占位 = 成品尺寸 + 2×出血边；件间可再设留边。
- 自动件按开数升序（同开按件号）用左下角装箱算法铺版；放不下级联到下一张纸。
- 手动件（拖放产生）锁定位置作为障碍，同张及以后纸张的自动件立即围绕它重排。

七条需求对照
------------

1. **幅面 / 咬口 / 出血定死拼版范围** — `usableRect` = 幅面减咬口；落位判定用含出血的占位框；
   纸张参数一改服务端立即 `reflow` 全部纸张。
2. **拖动成品，同张件立刻重排/顺延** — `placeManual` 后从受影响纸张起级联 `reflow`，
   前端 pointermove 每 120ms 以 draft 方式实时重算。
3. **放不下按开数顺序排下一张；同件不跨两张** — 级联队列按 `orderItems` 排序；
   `assertPlacementInvariant` 在每次重排和每个写接口前拒绝同件重复上纸。
4. **缺尺寸/开数/留边不能落版** — `isItemReady` 把关；前端清单标红禁拖，
   服务端 `addItem`/`placeManual`/终态校验三处都返回 400。留边是纸张级参数，缺省即 0，
   在纸张参数里配置后立即计入装箱。
5. **超幅面当场标红** — `placementFlags.overflow` 逐件判定，画布红框、纸标签红点、
   顶栏说明同时标出肇事件。
6. **咬口被压住整张不算数** — 占位框与 `gripperRect` 相交即 `gripperCovered`，
   该张标记无效并标出肇事件（黄色），直到移开。
7. **拖到一半切走/关页面可续排** — 拖动中以 `draft:true` 持久化到服务端文件，
   回来后底部横幅提示，可"接着摆 / 确认落版 / 放弃该件"。

接口
----

- `GET  /api/state` 当前完整状态 + 每张纸的有效性汇总
- `POST /api/action/updateSpec`
- `POST /api/action/addItem | updateItem | deleteItem`
- `POST /api/action/placeManual` `{itemId, sheetIndex, x, y, draft}`
- `POST /api/action/commitDraft | discardDraft | unpin | removePlacement`
- `POST /api/action/autoPack | addSheet`
