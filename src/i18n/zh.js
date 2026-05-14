// Chinese UI copy for SQL Coach.
// Each key is annotated with the requirement(s) it supports.
// All strings are user-facing; runtime code SHOULD reference ZH.* rather
// than inlining literals so the copy stays auditable in one place (R5.1).

/** @type {const} */
export const ZH = {
  // ------- App shell -------
  app: {
    // R5.1 — interface defaults to Chinese.
    title: 'SQL 教练',
  },

  // ------- Navigation -------
  nav: {
    practice: '练习',   // main practice loop entry
    history:  '历史',   // R15.1 / R15.4 history & wrong-answer review
    settings: '设置',   // R1.1 settings entry
    report:   '报告',   // R16.1 report entry (gated on ≥5 answers)
  },

  // ------- Settings view (R1, R2, R3) -------
  settings: {
    title:           '设置',                                            // R1.1
    apiBaseUrl:      'API 基础地址',                                    // R1.1
    apiKey:          'API 密钥',                                        // R1.1 / R1.7 masked
    modelName:       '模型名称',                                        // R1.1
    testConnection:  '测试连接',                                        // R1.6 (10s timeout)
    clearConfig:     '清除配置',                                        // R2.3
    show:            '显示',                                            // R1.7 reveal toggle
    hide:            '隐藏',                                            // R1.7 mask toggle
    // R3.2 — the page MUST tell the user that their LLM endpoint has
    // to allow cross-origin requests from this page's origin, before
    // they even attempt to use it.
    corsNotice:
      '提示：请确保你配置的 LLM 接口允许从本页面所在源（origin）发起跨域请求（CORS）。' +
      '若浏览器报 CORS 错误，需要在你的接口或反向代理上为本页面开启 Access-Control-Allow-Origin。',
  },

  // ------- Practice view (R6, R8) -------
  practice: {
    themePicker: {
      title: '选择业务主题',                                           // R6.1
      options: {
        ecommerce: '电商',                                              // R6.1
        campus:    '校园',                                              // R6.1
        library:   '图书馆',                                            // R6.1
        hospital:  '医院',                                              // R6.1
        custom:    '自定义',                                            // R6.1 / R6.6
      },
      customDescription: '请用一段中文描述你的自定义业务场景',          // R6.6
    },
    difficulty: {
      // R8.1 — four difficulty levels exposed in the picker.
      L1: '基础',
      L2: '进阶',
      L3: '难点',
      L4: '综合',
    },
    startQuestion: '出题',          // R8 entry to QuestionGen
    submit:        '提交',          // R12 submit user SQL
    formatSql:     '格式化 SQL',    // R18.3
    reset:         '重置数据库',    // R10.6 / R11.4
    showAnswer:    '显示参考答案',  // R13.6
  },

  // ------- Judge / verdict (R12) -------
  judge: {
    correct:         '回答正确',                                       // R12.5
    wrong:           '回答错误',                                       // R12.6
    diffMissingRows: '缺少的行数',                                     // R12.6 diff summary
    diffExtraRows:   '多出的行数',                                     // R12.6 diff summary
    executeError:    '你的 SQL 在沙箱中执行失败',                      // R12.7
  },

  // ------- Tutor view (R13) -------
  tutor: {
    title:       '错题解析',          // R13.1
    placeholder: '继续追问……',        // R13.3 multi-turn input
    send:        '发送',
    thinking:    'Tutor 正在思考…',   // shown while a turn is in flight
  },

  // ------- History view (R15.4 / R15.5) -------
  history: {
    title:       '历史与错题',        // R15.4
    filterWrong: '只看错题',          // R15.4
    clear:       '清空历史',          // R15.5 (settings preserved)
    // R15.4 — exact string referenced by Property 11; do NOT change wording
    // without also updating tests/ui/history-view.property.test.js.
    empty:       '没有符合条件的错题',
  },

  // ------- Report view (R16) -------
  report: {
    title:          '能力报告',        // R16.1
    exportMarkdown: '导出 Markdown',   // R16.4
  },

  // ------- Error toasts (R3 / R14) -------
  errors: {
    unauthorized:    'API Key 无效或无权限，请前往设置检查。',          // R14.1
    rateLimited:     '当前被限流，请稍后重试。',                        // R14.2
    serverError:     'LLM 服务端错误，请稍后重试。',                    // R14.3
    timeout:         '请求超时（60 秒），请检查网络或稍后重试。',       // R14.4 / R3.3
    // R3.1 — the literal substring 'CORS' MUST appear so the user
    // can correlate the message with their browser's console error.
    cors:            '跨域被拒（CORS）：请确认你的 LLM 接口允许本页面的源访问。',
    network:         '网络异常，请检查连接后重试。',                    // R14 misc
    badResponse:     '模型返回格式异常，请重试。',                      // R14.6 bad_response
    sandboxTimeout:  '沙箱执行超时（5 秒），已自动重置数据库。',        // R10.2 / R11.3
    sandboxRowLimit: '结果行数已截断到上限（10000 行）。',              // R10.5
  },

  // ------- Sandbox safety filter (R11) -------
  sandbox: {
    rejectedDdl: '已拒绝执行：禁止使用 DDL 关键字（DROP/ALTER/TRUNCATE 等）。',  // R11.1
    rejectedDml: '已拒绝执行：当前题目不允许 INSERT/UPDATE/DELETE。',          // R11.2
  },

  // ------- localStorage quota dialog (R15.6) -------
  quota: {
    title:      '保存失败',                                              // R15.6
    message:    '本地存储空间不足，无法保存最新数据。请导出 JSON 备份。', // R15.6
    exportJson: '导出 JSON',                                             // R15.6
  },
};

export default ZH;
