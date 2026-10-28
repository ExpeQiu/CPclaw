import {randomUUID} from 'node:crypto';

const rules={
  MEDIA_DELIVERY:{repair:'恢复已有图片、核实文件并准备预览',prevention:'生成、下载、预览分别记录终态；保留原图与校验回执，按原资源恢复，不重新生成。'},
  MEDIA_PENDING:{repair:'查询原提交并核实已有资源',prevention:'提交身份持久化；中断后先查询原提交，受理状态不作为完成。'},
  MEDIA_RESUME:{repair:'按原提交查询并补下载已有资源',prevention:'续接只查询原身份、核实资源并补下载，不重新提交生成；完成后回读成果。'},
  CLI_NODE_ID_INVALID:{repair:'按当前CLI规范生成或核实节点ID',prevention:'宿主生成10位Crockford Base32节点ID；复用已有节点身份，不依赖模型猜测。'},
  CLI_ARGUMENT_INVALID:{repair:'按实时能力定义修正参数',prevention:'发送前按schema检查参数；布尔开关不附加true；同一无效参数不原样重试。'},
  LOCAL_TOOL_ARGUMENTS:{repair:'使用顶层command等字段',prevention:'终端请求采用明确契约，失败回执返回正确结构示例。'},
  MODEL_STEP_LIMIT:{repair:'先查询原提交或恢复已有成果',prevention:'优先复用持久化执行回执；禁止整轮重放已有外部操作。'},
  HARNESS_GATEWAY:{repair:'保留现场并查询原任务，不推测远端原因',prevention:'网关失败后先核实已有提交与成果，避免重复生成；服务端根因需要对应网关证据。'},
  HARNESS_RATE_LIMIT:{repair:'区分模型额度耗尽、并发满及临时请求限制',prevention:'保留平台错误原因并读取模型额度；只读准备可续接，已有生成或写入不整轮重跑。'},
  MODEL_QUOTA_EXHAUSTED:{repair:'明确模型tokens额度与即梦积分的区别并报告管理员处理',prevention:'任务开始前检查模型额度；低余额提前提示。额度为零时停止请求，不以重复重试增加消耗。'},
  MODEL_CONCURRENCY_FULL:{repair:'等待原调用释放并发位后续接',prevention:'核实并发占用，避免通过重复发起任务增加竞争。'},
  MODEL_QUOTA_LOW:{repair:'提前处理平台模型额度',prevention:'任务前和诊断时核实剩余模型额度，低于10%时提示。'},
  HARNESS_CLEANUP:{repair:'检查工作进程并隔离重启前后的回执',prevention:'退出等待有上限；旧进程事件不能清除新进程请求；保留原始执行证据。'},
  DREAMINA_AUTH_SCOPE:{repair:'完成官方授权后复查服务端账号与画布',prevention:'本地登录状态与服务端权限分别核实；已有授权挑战不重复发起。'},
  EMPTY_REPLY:{repair:'从已保存回执恢复摘要',prevention:'异常退出也持久化工具回执；摘要恢复不代表原任务完成。'},
  SKILL_INSTALL_MISSING:{repair:'重装固定版本并回读校验',prevention:'运行前检查绑定技能的制品与版本，不自动改写技能正文。'},
};

/** Account-scoped evidence ledger, storing codes and verified outcomes rather than prompts/secrets. */
export function createDiagnosticJournal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_runs(
    id TEXT PRIMARY KEY,scope TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,checked INTEGER NOT NULL,
    codes TEXT NOT NULL,repairs TEXT NOT NULL,task_state TEXT NOT NULL,repair_state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS diagnostic_lessons(
    scope TEXT NOT NULL,code TEXT NOT NULL,occurrences INTEGER NOT NULL,verified INTEGER NOT NULL,last_seen INTEGER NOT NULL,
    PRIMARY KEY(scope,code));`);
  function lessons(scope,codes) {
    return db.prepare('SELECT code,occurrences,verified,last_seen AS lastSeen FROM diagnostic_lessons WHERE scope=? ORDER BY verified DESC,last_seen DESC').all(scope)
      .filter(row=>rules[row.code]&&(!codes||codes.includes(row.code)||row.code==='MEDIA_RESUME'&&codes.includes('MEDIA_PENDING'))).map(row=>({...row,...rules[row.code],state:row.verified>0?'verified':'observed',source:'host-evidence'}));
  }
  return {
    lessons,
    record(scope,chat,message,{findings,repairs,task}) {
      const codes=[...new Set(findings.filter(f=>['error','warn','fixed'].includes(f.status)&&rules[f.code]).map(f=>f.code))];
      const actions=repairs.map(r=>({code:r.code,verified:r.verified===true}));
      const verifiedCodes=actions.filter(a=>a.verified&&rules[a.code]).map(a=>a.code);
      const all=[...new Set([...codes,...verifiedCodes])],now=Date.now(),id=randomUUID();
      const repairState=!actions.length?'none':actions.every(a=>a.verified)?'verified':'failed';
      db.exec('BEGIN IMMEDIATE');
      try{
        db.prepare('INSERT INTO diagnostic_runs VALUES(?,?,?,?,?,?,?,?,?)').run(id,scope,chat,message||'',now,JSON.stringify(all),JSON.stringify(actions),task.status,repairState);
        for(const code of all){
          const occurrences=db.prepare(`SELECT COUNT(DISTINCT chat||':'||message) AS n FROM diagnostic_runs WHERE scope=? AND EXISTS(SELECT 1 FROM json_each(codes) WHERE value=?)`).get(scope,code).n;
          const verified=db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_runs WHERE scope=? AND EXISTS(SELECT 1 FROM json_each(repairs) WHERE json_extract(value,'$.code')=? AND json_extract(value,'$.verified')=1)`).get(scope,code).n;
          db.prepare('INSERT INTO diagnostic_lessons VALUES(?,?,?,?,?) ON CONFLICT(scope,code) DO UPDATE SET occurrences=excluded.occurrences,verified=excluded.verified,last_seen=excluded.last_seen').run(scope,code,occurrences,verified,now);
        }
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      const relevant=[...all,...(task.images?.length?['MEDIA_DELIVERY','MEDIA_RESUME']:[])];
      return {runId:id,repairState,experience:lessons(scope,relevant)};
    },
  };
}
