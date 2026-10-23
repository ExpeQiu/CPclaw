import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureEmployees, openPlatform } from "../dist/index.js";

const secret = "test-session-secret-0123456789abcdef";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-p4-"));
}

function openFixture() {
  const dataDir = tempDir();
  const clock = { now: 1_700_000_000_000 };
  const opened = openPlatform({
    dataDir,
    port: 0,
    listenHost: "127.0.0.1",
    sessionSecret: secret,
    accessTtlSec: 60,
    refreshTtlSec: 3600,
    seed: { kind: "fixture", employees: fixtureEmployees },
    keyPresent: false,
    now: () => clock.now,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    throw new Error("平台没有打开");
  }
  return { dataDir, clock, app: opened.app };
}

function login(app, employeeId, deviceLabel = "device-1") {
  const passwords = {
    admin: "fixture-admin",
    "employee-a": "fixture-employee-a",
    "employee-b": "fixture-employee-b",
    "employee-c": "fixture-employee-c",
  };
  const result = app.login({ employeeId, password: passwords[employeeId], deviceLabel });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("登录失败");
  }
  return result;
}

function readyChannel(app, clock, opts) {
  const admin = login(app, "admin");
  const employee = login(app, opts.employeeId, opts.deviceLabel ?? "pc-1");
  assert.equal(
    app.ensureChannelInstallation(admin.accessToken, {
      channel: opts.channel,
      channelTenantId: opts.tenantId,
      appId: opts.appId,
    }).ok,
    true,
  );
  const pairing = app.startChannelPairing(employee.accessToken, {
    channel: opts.channel,
    channelTenantId: opts.tenantId,
    appId: opts.appId,
  });
  assert.equal(pairing.ok, true);
  const bound = app.completeChannelPairing(employee.accessToken, {
    pairingToken: pairing.pairingToken,
    externalUserId: opts.externalUserId,
  });
  assert.equal(bound.ok, true);
  assert.equal(app.registerRemoteDevice(employee.accessToken, { deviceId: opts.deviceId }).ok, true);
  assert.equal(app.setRemoteEnabled(employee.accessToken, { deviceId: opts.deviceId, enabled: true }).ok, true);
  assert.equal(app.connectRemoteDevice(employee.accessToken, opts.deviceId).ok, true);
  const conversation = app.bindImConversation(employee.accessToken, {
    bindingId: bound.binding.bindingId,
    conversationId: opts.conversationId,
    deviceId: opts.deviceId,
    taskId: opts.taskId,
    outputScope: opts.outputScope ?? "summary",
  });
  assert.equal(conversation.ok, true);
  return { admin, employee, binding: bound.binding, conversation: conversation.conversation, clock };
}

test("P4-01 配对、固定设备、commandId 去重与过期", () => {
  const { app, clock } = openFixture();
  try {
    const ctx = readyChannel(app, clock, {
      channel: "feishu",
      tenantId: "tenant-fs",
      appId: "app-fs",
      employeeId: "employee-a",
      externalUserId: "fs-user-a",
      deviceId: "pc-a",
      conversationId: "conv-fs-1",
      taskId: "task-fs-1",
    });
    const first = app.receiveChannelEvent({
      channel: "feishu",
      channelTenantId: "tenant-fs",
      appId: "app-fs",
      conversationId: "conv-fs-1",
      externalUserId: "fs-user-a",
      messageId: "msg-1",
      text: "生成报告草稿",
    });
    assert.equal(first.ok, true);
    assert.equal(first.ack.status, "accepted_by_platform");
    assert.equal(first.ack.protocolAck, true);
    assert.ok(first.ack.commandId);

    const dup = app.receiveChannelEvent({
      channel: "feishu",
      channelTenantId: "tenant-fs",
      appId: "app-fs",
      conversationId: "conv-fs-1",
      externalUserId: "fs-user-a",
      messageId: "msg-1",
      text: "生成报告草稿",
    });
    assert.equal(dup.ok, true);
    assert.equal(dup.ack.status, "duplicate");
    assert.equal(dup.ack.commandId, first.ack.commandId);

    const polled = app.pollRelayCommands(ctx.employee.accessToken, "pc-a");
    assert.equal(polled.ok, true);
    assert.equal(polled.commands.length, 1);
    assert.equal(polled.commands[0].commandId, first.ack.commandId);

    const accepted = app.acceptRelayCommand(ctx.employee.accessToken, {
      deviceId: "pc-a",
      commandId: first.ack.commandId,
      taskId: "task-fs-1",
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.replayed, false);
    const replay = app.acceptRelayCommand(ctx.employee.accessToken, {
      deviceId: "pc-a",
      commandId: first.ack.commandId,
      taskId: "task-other",
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.taskId, "task-fs-1");

    const late = app.receiveChannelEvent({
      channel: "feishu",
      channelTenantId: "tenant-fs",
      appId: "app-fs",
      conversationId: "conv-fs-1",
      externalUserId: "fs-user-a",
      messageId: "msg-expire",
      text: "过期指令",
    });
    assert.equal(late.ok, true);
    assert.ok(late.ack.commandId);
    clock.now += 6 * 60 * 1000;
    // 时钟前移会使短效 access 过期，重新登录后再查过期信封。
    const again = login(app, "employee-a", "device-1");
    assert.equal(app.connectRemoteDevice(again.accessToken, "pc-a").ok, true);
    const expiredPoll = app.pollRelayCommands(again.accessToken, "pc-a");
    assert.equal(expiredPoll.ok, true);
    assert.equal(expiredPoll.commands.length, 0);
    const expiredAccept = app.acceptRelayCommand(again.accessToken, {
      deviceId: "pc-a",
      commandId: late.ack.commandId,
      taskId: "task-fs-1",
    });
    assert.equal(expiredAccept.ok, false);
    if (!expiredAccept.ok) {
      assert.equal(expiredAccept.code, "FORBIDDEN");
    }
  } finally {
    app.close();
  }
});

test("P4-02 飞书单聊：发问→PC 受理→原会话回复；ACK 不冒充受理；回复失败只重试回复", () => {
  const { app, clock } = openFixture();
  try {
    const ctx = readyChannel(app, clock, {
      channel: "feishu",
      tenantId: "tenant-fs",
      appId: "app-fs",
      employeeId: "employee-a",
      externalUserId: "fs-user-a",
      deviceId: "pc-a",
      conversationId: "conv-fs-2",
      taskId: "task-fs-2",
    });
    const event = app.receiveChannelEvent({
      channel: "feishu",
      channelTenantId: "tenant-fs",
      appId: "app-fs",
      conversationId: "conv-fs-2",
      externalUserId: "fs-user-a",
      messageId: "msg-ask",
      text: "请补充第二节",
    });
    assert.equal(event.ok, true);
    assert.equal(event.ack.status, "accepted_by_platform");
    const beforeAccept = app.getRelayCommand(ctx.employee.accessToken, event.ack.commandId);
    assert.equal(beforeAccept.ok, true);
    assert.equal(beforeAccept.receipt.status, "pending");

    assert.equal(
      app.acceptRelayCommand(ctx.employee.accessToken, {
        deviceId: "pc-a",
        commandId: event.ack.commandId,
        taskId: "task-fs-2",
      }).ok,
      true,
    );

    const failed = app.enqueueImOutbound(ctx.employee.accessToken, {
      commandId: event.ack.commandId,
      body: "第二节已补充",
      failMode: "once",
    });
    assert.equal(failed.ok, true);
    assert.equal(failed.delivery.status, "failed");
    assert.equal(failed.delivery.attempts, 1);
    const afterFail = app.getRelayCommand(ctx.employee.accessToken, event.ack.commandId);
    assert.equal(afterFail.ok, true);
    assert.equal(afterFail.receipt.status, "accepted");

    const retried = app.retryImOutbound(ctx.employee.accessToken, failed.delivery.deliveryId);
    assert.equal(retried.ok, true);
    assert.equal(retried.delivery.status, "submitted");
    assert.equal(retried.delivery.conversationId, "conv-fs-2");
    assert.equal(retried.delivery.channel, "feishu");

    const leak = app.enqueueImOutbound(ctx.employee.accessToken, {
      commandId: event.ack.commandId,
      body: "文件在 /Users/expe/report.md",
    });
    assert.equal(leak.ok, false);
    if (!leak.ok) {
      assert.equal(leak.code, "FORBIDDEN");
    }
  } finally {
    app.close();
  }
});

test("P4-03 企微单聊独立闭环，不能由飞书共用代码推定", () => {
  const { app, clock } = openFixture();
  try {
    const ctx = readyChannel(app, clock, {
      channel: "wecom",
      tenantId: "tenant-wc",
      appId: "app-wc",
      employeeId: "employee-a",
      externalUserId: "wc-user-a",
      deviceId: "pc-wc",
      conversationId: "conv-wc-1",
      taskId: "task-wc-1",
    });
    const event = app.receiveChannelEvent({
      channel: "wecom",
      channelTenantId: "tenant-wc",
      appId: "app-wc",
      conversationId: "conv-wc-1",
      externalUserId: "wc-user-a",
      messageId: "wc-msg-1",
      text: "企微提问",
    });
    assert.equal(event.ok, true);
    assert.equal(event.ack.status, "accepted_by_platform");
    assert.equal(
      app.acceptRelayCommand(ctx.employee.accessToken, {
        deviceId: "pc-wc",
        commandId: event.ack.commandId,
        taskId: "task-wc-1",
      }).ok,
      true,
    );
    const out = app.enqueueImOutbound(ctx.employee.accessToken, {
      commandId: event.ack.commandId,
      body: "企微已回复",
    });
    assert.equal(out.ok, true);
    assert.equal(out.delivery.channel, "wecom");
    assert.equal(out.delivery.conversationId, "conv-wc-1");
    assert.equal(out.delivery.status, "submitted");

    const cross = app.receiveChannelEvent({
      channel: "feishu",
      channelTenantId: "tenant-fs",
      appId: "app-fs",
      conversationId: "conv-fs-x",
      externalUserId: "wc-user-a",
      messageId: "cross-1",
      text: "串渠道",
    });
    assert.equal(cross.ok, true);
    assert.equal(cross.ack.status, "rejected");
  } finally {
    app.close();
  }
});

test("P4-04 同任务绑定、离线、两员工隔离、撤销阻断", () => {
  const { app, clock } = openFixture();
  try {
    const a = readyChannel(app, clock, {
      channel: "feishu",
      tenantId: "tenant-fs",
      appId: "app-fs",
      employeeId: "employee-a",
      externalUserId: "fs-user-a",
      deviceId: "pc-a",
      conversationId: "conv-shared",
      taskId: "task-shared",
    });
    const b = login(app, "employee-b", "pc-b");
    assert.equal(app.registerRemoteDevice(b.accessToken, { deviceId: "pc-b" }).ok, true);

    const offline = app.disconnectRemoteDevice(a.employee.accessToken, "pc-a");
    assert.equal(offline.ok, true);
    const whileOffline = app.receiveChannelEvent({
      channel: "feishu",
      channelTenantId: "tenant-fs",
      appId: "app-fs",
      conversationId: "conv-shared",
      externalUserId: "fs-user-a",
      messageId: "msg-offline",
      text: "离线期间的指令",
    });
    assert.equal(whileOffline.ok, true);
    assert.equal(whileOffline.ack.status, "device_offline");
    assert.equal(whileOffline.ack.commandId, undefined);

    assert.equal(app.connectRemoteDevice(a.employee.accessToken, "pc-a").ok, true);
    const afterOnline = app.pollRelayCommands(a.employee.accessToken, "pc-a");
    assert.equal(afterOnline.ok, true);
    assert.equal(afterOnline.commands.length, 0);

    const again = app.receiveChannelEvent({
      channel: "feishu",
      channelTenantId: "tenant-fs",
      appId: "app-fs",
      conversationId: "conv-shared",
      externalUserId: "fs-user-a",
      messageId: "msg-online",
      text: "上线后新指令",
    });
    assert.equal(again.ok, true);
    assert.equal(again.ack.status, "accepted_by_platform");
    assert.equal(
      app.acceptRelayCommand(a.employee.accessToken, {
        deviceId: "pc-a",
        commandId: again.ack.commandId,
        taskId: "task-shared",
      }).ok,
      true,
    );

    const steal = app.acceptRelayCommand(b.accessToken, {
      deviceId: "pc-b",
      commandId: again.ack.commandId,
      taskId: "task-b",
    });
    assert.equal(steal.ok, false);

    assert.equal(app.revokeChannelBinding(a.employee.accessToken, a.binding.bindingId).ok, true);
    const blockedNew = app.receiveChannelEvent({
      channel: "feishu",
      channelTenantId: "tenant-fs",
      appId: "app-fs",
      conversationId: "conv-shared",
      externalUserId: "fs-user-a",
      messageId: "msg-after-revoke",
      text: "撤销后输入",
    });
    assert.equal(blockedNew.ok, true);
    assert.equal(blockedNew.ack.status, "rejected");

    const blockedOut = app.enqueueImOutbound(a.employee.accessToken, {
      commandId: again.ack.commandId,
      body: "撤销后不应外发",
    });
    assert.equal(blockedOut.ok, false);
    if (!blockedOut.ok) {
      assert.equal(blockedOut.code, "FORBIDDEN");
    }
  } finally {
    app.close();
  }
});

test("P4-04 无回执标记待核实；不换设备重跑", () => {
  const { app, clock } = openFixture();
  try {
    const ctx = readyChannel(app, clock, {
      channel: "wecom",
      tenantId: "tenant-wc",
      appId: "app-wc",
      employeeId: "employee-a",
      externalUserId: "wc-user-a",
      deviceId: "pc-a",
      conversationId: "conv-wc-2",
      taskId: "task-wc-2",
    });
    const event = app.receiveChannelEvent({
      channel: "wecom",
      channelTenantId: "tenant-wc",
      appId: "app-wc",
      conversationId: "conv-wc-2",
      externalUserId: "wc-user-a",
      messageId: "msg-unknown",
      text: "投递无回执",
    });
    assert.equal(event.ok, true);
    const marked = app.markRelayDeliveryUnknown(ctx.employee.accessToken, event.ack.commandId);
    assert.equal(marked.ok, true);
    assert.equal(marked.receipt.status, "delivery_unknown");

    assert.equal(app.registerRemoteDevice(ctx.employee.accessToken, { deviceId: "pc-other" }).ok, true);
    assert.equal(app.setRemoteEnabled(ctx.employee.accessToken, { deviceId: "pc-other", enabled: true }).ok, true);
    assert.equal(app.connectRemoteDevice(ctx.employee.accessToken, "pc-other").ok, true);
    const otherAccept = app.acceptRelayCommand(ctx.employee.accessToken, {
      deviceId: "pc-other",
      commandId: event.ack.commandId,
      taskId: "task-wc-2",
    });
    assert.equal(otherAccept.ok, false);
  } finally {
    app.close();
  }
});
