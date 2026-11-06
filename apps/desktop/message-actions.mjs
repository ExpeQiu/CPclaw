/** 用户可明确选择任一已结束的助手回复作为提炼来源；内容是否足够由 Harness 判断。 */
export function canOfferSkillDistill(_messages,message,_options={}){
  return Boolean(message&&message.role==='assistant'&&message.state==='done');
}
