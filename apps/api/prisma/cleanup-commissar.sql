-- 部门与角色重构前数据清理：项目内政委(COMMISSAR)降为普通成员（枚举将移除 COMMISSAR）
UPDATE "ProjectMember" SET role = 'MEMBER' WHERE role = 'COMMISSAR';
