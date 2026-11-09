# 时间、到达与成熟度

所有业务日UTC。cohort_date/安装日、observe_date/观察日、revenue_date/收入日、snapshot_date/快照日和arrival_cutoff/到达截止不同。

RR7是第7日；累计ROI7是日龄0..6。未成熟不是0。AF回调比SDK延迟，fresh不证明任意cohort成熟。最后一天可存在未到AF事件，用completeness_state与发布目标分别判断。
