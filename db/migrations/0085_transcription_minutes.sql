-- Keep integer-second grants, order entitlements and running-session snapshots intact.
-- Only convert the untouched default rate (one second per second) to one minute per minute.
-- Custom administrator prices are preserved; their minute values are editable in the UI.
INSERT INTO public.billing_policy_versions(config,reason)
SELECT jsonb_set(config,'{rules,interview_audio}',
 jsonb_build_object('enabled',config#>'{rules,interview_audio,enabled}',
 'resource','interview_seconds','quantity',60,'unitSize',60)),
 '转写默认改为每累计一分钟扣除一分钟额度，保留历史快照及自定义价格'
FROM (SELECT config FROM public.billing_policy_versions ORDER BY id DESC LIMIT 1) latest
WHERE config#>>'{rules,interview_audio,resource}'='interview_seconds'
 AND config#>>'{rules,interview_audio,quantity}'='1'
 AND config#>>'{rules,interview_audio,unitSize}'='1';
