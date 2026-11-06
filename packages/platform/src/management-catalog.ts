/** Current desktop/cloud ownership. Reserved domain APIs are not advertised as live desktop features. */
export const managementCatalog = [
  { id:'account', title:'账号与设备会话', scope:'cloud', desktop:'企业端登录、退出、自动续期', endpoints:['/v1/session/login','/v1/session/refresh','/v1/session/logout','/v1/me/sessions'], management:'员工、角色、口令与会话撤销', page:'employees' },
  { id:'quota', title:'模型与用量', scope:'cloud', desktop:'聊天、报告、项目 Wiki、技能草稿', endpoints:['/v1/me/quota','/v1/me/quota-requests','/v1/chat/stream','/v1/reports/generate','/v1/harness/completions','/v1/models/reserve','/v1/models/settle','/v1/models/invoke'], management:'额度、并发、用量台账、增额记录；无聊天正文', page:'usage' },
  { id:'market', title:'技能与场景专家', scope:'cloud', desktop:'技能市场、草稿、审核、发布与安装偏好', endpoints:['/v1/market'], management:'版本审核、发布、下架与紧急停用', page:'skills' },
  { id:'connector', title:'应用服务连接器', scope:'mixed', desktop:'CLI / MCP 自定义服务连接；本机实际执行', endpoints:['/v1/market'], management:'云端登记连接器台账、组织禁用；本机凭证与授权仍在桌面', page:'connectors' },
  { id:'knowledge', title:'企业知识库', scope:'cloud', desktop:'平台企业 Wiki、成员权限、文档与引用', endpoints:['/v1/knowledge'], management:'企业库、成员、文档维护；个人库不进入组织管理', page:'knowledge' },
  { id:'diagnostic', title:'诊断与同步', scope:'mixed', desktop:'只读诊断、主动上传诊断包', endpoints:['/v1/diagnostics','/v1/diagnostics/:id','/v1/diagnostics/:id/content','/v1/me/request-traces','/v1/me/request-traces/:id'], management:'诊断内容与上传状态、日志同步回执；不读取其他私人制品', page:'uploads' },
  { id:'learning', title:'企业学习资源与发布 Wiki', scope:'cloud', desktop:'授权自学习、自动提交待审候选、按范围查看已发布资源', endpoints:['/v1/learning','/v1/admin/manage'], management:'开关、待审候选、按成员下发、资源下架、Wiki 修订审核', page:'learning' },
  { id:'im', title:'IM 与远程设备', scope:'reserved', desktop:'测试应用与回调未验证前不接入消息；Mock 渠道不能代替正式闭环', endpoints:['/v1/admin/manage'], management:'仅展示已有登记与投递状态，不表示真实渠道已接入', page:'integrations' },
  { id:'projects', title:'本地项目与项目 Wiki', scope:'local', desktop:'项目目录、聊天关联、知识压缩与版本', endpoints:[], management:'桌面管理；云端仅统计模型用量，不上传目录或项目文件', page:'' },
  { id:'documents', title:'本地聊天与文档', scope:'local', desktop:'聊天历史、报告、文档工作区、创作过程', endpoints:[], management:'桌面账号隔离保存，不开放云端读取个人历史或文件', page:'' },
  { id:'permissions', title:'本机命令与应用授权', scope:'local', desktop:'工具授权、Computer Use、CLI、MCP、积分确认', endpoints:[], management:'由桌面宿主执行授权；云端连接器禁用不授予本机执行权限', page:'' },
  { id:'local-knowledge', title:'本地知识库与个人平台库', scope:'local', desktop:'本地目录、个人 Wiki、知识来源选择', endpoints:['/v1/knowledge'], management:'本地目录和个人平台库由本人维护，不开放管理员读取', page:'' },
] as const;
