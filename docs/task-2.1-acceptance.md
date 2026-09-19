# Lattice Task 2.1 验收报告与修复建议

结论：FAIL，需要修复后重新验收；不建议开始 Task 2.2 写入功能。

审查版本：bb3de1f27fd624332aeb76b6928c4b2c1f3f5205（main，feat: add transactional vault repository）。环境：macOS，Node.js v22.23.1。npm test：36/36 通过，其中持久化测试实际为 15 项，开发计划写成 16/16。未修改仓库源码或真实 vault；额外探针使用复制的 synthetic fixtures 和独立临时目录。未在目标 Linux 环境做断电级验证。

## 验收矩阵

| 要求 | 结果 |
|---|---|
| 正常 state + note + checkpoint | 现有正常路径测试通过 |
| revision/fingerprint 冲突 | 明确提供旧 revision 的测试通过；缺失或 null revision 的语义有缺陷 |
| one-writer lock | 同一路径第二实例被拒绝；异常退出及路径别名不合格 |
| operation/update 幂等 | 正常 operation 重放通过；commit-marker 恢复后结果丢失；独立 update ID 重放未被现有测试覆盖 |
| durable staging/journal | 有 staging、原始内容、fsync 和 journal；目录创建持久化及真实崩溃覆盖不足 |
| atomic per-file replacement | 有同目录临时文件、fsync、rename 和目录 flush；写路径未拒绝逃逸符号链接 |
| commit marker / operation record | 正常路径通过；恢复时结果重建不完整 |
| restart recovery | 正常 close 后模拟恢复通过；进程未 close 时被残留锁阻断 |
| external-edit conflicts | 部分检测通过；遗漏 revisions 可静默覆盖外部修改 |
| deterministic failure injection | 已实现；没有逐文件、逐持久化窗口全覆盖 |
| state + note + checkpoint 逻辑事务 | 正常路径通过；失败后读屏障失效 |
| no-op | 带 checkpoint 示例通过；空 files 的 no-op 也直接 saved=true |
| 不出现错误 saved/completed 或混合读取 | 不通过：混合快照可读、空 no-op 可 saved、恢复结果不完整 |

## 必须修复的问题

### 1. P1：失败后的混合快照与提交串行化不成立

位置：runtime/vault/repository.mjs，snapshot/commit（原提交 L164–189）。

复现：在 after-file-replace 且 index===0 注入异常。commit 抛错，但 finally 清空 committing；随后 snapshot 直接读取 canonical 文件。实测新 state marker=partial，note 仍为旧内容。失败事务既未立即恢复，也未阻止后续读取/写入。

另外，两个等待同一前置 promise 的 commit 会在该 promise 完成后同时进入 #commit。三个提交及确定性 gate 复现：A 停在 after-applying-marker，排队 B/C，再释放 A；B 停在 before-manifest-prepared 时，C 已进入 prepare。close 也没有等待进行中的提交结束就释放 writer lock。

建议：使用真正串行队列/互斥机制，让读、写、恢复、关闭共享生命周期控制；事务失败后进入 recovery-required 状态，完成恢复或明确隔离 topic 前不得返回正常快照或接受后续写入。

### 2. P1：异常退出后无法启动恢复，同一 vault 别名可绕过锁

位置：repository.mjs，operationalRoot、initialize、acquireWriterLock（原 L45–48、L113–145）。

writer.lock 使用 wx 创建，只有 close 删除。独立子进程 initialize 后直接 process.exit(0)，没有执行 close；下一实例 initialize 返回 writer-locked，recover 根本不能运行。现有 restart 测试全部先 close，漏掉这一问题。

锁目录哈希基于 path.resolve 而非真实文件系统路径。通过符号链接别名打开同一 vault，第二实例成功获得另一把锁。

建议：按真实 vault 身份确定锁；采用进程退出自动释放的锁，或实现具有进程身份验证与竞争保护的残留锁恢复。补充子进程被终止、同时竞争残留锁和符号链接别名测试，不能靠无条件删除锁解决。

### 3. P1：commit marker 后恢复丢失幂等结果

位置：repository.mjs，#recoverTransaction、#replayOrRecover（原 L245–284）。

复现：after-commit-marker 注入异常后关闭并重启。恢复将 operation 写为 committed/saved，但没有写 result。相同 operation 重放实际只返回 {"replayed":true}，没有 status、saved 或 targetRevisions；#findUpdate 也依赖缺失的 operation.result。

此外，manifest 已 committed 而 operation 尚 pending 的窗口被 recover 跳过，重试走 #apply，未把已有 commit marker 当成不可撤销的成功事实。

建议：从 commit marker 与 manifest 重建完整、稳定的结果；启动时同时对账 manifest、marker 和 operation record。已提交事务只能修复记录和重放，不能再次应用或回滚。补测 marker/manifest/operation 各边界及新 operation ID 携带同一 update ID 的重试。

### 4. P1：缺失 expected revision 静默覆盖，null 不代表必须不存在

位置：repository.mjs，#prepare（原 L294–305）。

expectedRevisions 可以为空，#prepare 将当时读到的内容指纹当作 base。复现：生成旧 proposal 后外部新增 state 字段，提交时省略 revisions，结果 committed，外部字段消失。

expected ?? relativeFingerprint(before) 同时把显式 null 当作缺省，无法表达新文件创建时此路径必须不存在，已有文件可能被覆盖。

建议：所有写目标必须携带明确预期版本；区分属性缺失、null 与具体指纹。现有文件提供正确指纹，新文件提供 null 并验证确实不存在。保留完整 read-set 检查。

### 5. P1：写入路径可通过符号链接逃出 vault

位置：repository.mjs，#secureTarget（原 L442–449）。

仅检查字符串前缀和词法 root containment。复现：notes 下放置指向临时 vault 外部目录的符号链接，将其子路径作为新 note 并纳入 state 索引；commit 返回 committed，外部目录出现写入文件。

建议：校验规范化后的 topic containment，并检查已有父目录真实路径/符号链接；新文件也要验证父目录。回滚和恢复采用相同规则。为 .. topic 逃逸、符号链接和路径别名增加拒绝测试。

### 6. P2：no-op 与逻辑文件完整性没有形成可验收契约

位置：repository.mjs，#validateRequest、#validateLogicalFiles（原 L451–496）。

复现：noOp:true, files:[] 返回 committed/saved=true，没有 checkpoint。#validateLogicalFiles 只验证写入的 note/session 在 state 中有索引，没有反向保证新索引对应的文件存在或在事务中写入。

checkpoint 内容和学习语义可以留在 Phase 4，但 Task 2.1 必须明确底层接口能保证什么，并用完整 state+note+checkpoint 失败用例证明 required files 不会遗漏。区分底层空存储事务与学习 no-op；后者要求有效 state revision 与 checkpoint。文档需统一 state.json 不变与新增 state.sessions 的含义。

## 测试覆盖与持久化限制

- 恢复测试使用两文件 state+note proposal，不包含新 checkpoint；恢复断言只检查 state marker，没有检查 note、checkpoint、commit record 或重放结果。
- after-file-replace 只在第一次命中时失败，未覆盖每个文件索引；before-file-replace 未作为恢复矩阵逐项测试。
- 没有真实进程终止、并发提交、失败后直接 snapshot、读写重叠、恢复过程中再次失败的覆盖。
- after-operation-record、rename 成功但 journal 尚未更新、部分 write/fsync/rename 失败与磁盘空间不足等窗口未覆盖。现有 hook 多在完整文件替换与 journal 写入之后，不能等同于所有系统调用边界崩溃覆盖。
- mkdirp 没有同步新目录父目录，尤其 transactions/<operationId> 的父目录持久化缺少明确保证。文件 fsync 与 rename 后目录 sync 不足以自动证明新建目录层级断电后可达。此项为静态审查风险，未做断电复现。
- 已有 marker 的恢复应重建已提交结果；没有 marker 的恢复必须先校验 staged bytes 与 target fingerprint，再触碰 canonical 文件。
- vault contract 仍要求 commit marker 前失败 canonical 文件不变，而实现允许部分替换并等待 roll-forward。应统一为可测试的恢复契约，明确冲突未解决时哪些读写被阻止。

## 修复交付要求

先读取 AGENTS.md 与现有架构/契约，逐项复现、判断并修复以上问题；将复现转为有意义的回归测试。只做 Task 2.1 加固，不启动 Task 2.2、UI 编辑、Codex 接入、Reducer 或 Git 同步功能。故障注入仅使用合成副本，不访问真实 learning-vault 做破坏测试。

保持本报告作为审查基线；另行记录每项修复、验证命令、结果与限制。修订 development-plan、architecture、vault-contract 中不准确的状态/契约/测试数字。在目标 Linux 上运行完整测试，确认所有 P1 消除后再标记 Task 2.1 complete。不自动提交或推送，留给用户检查。
