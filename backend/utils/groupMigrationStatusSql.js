'use strict';

/** SQL fragments for oe.Groups list/detail — E123 map + pending migration members. */
const GROUP_MIGRATION_STATUS_SELECT_SQL = `
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.MigrationGroupMap mgm WHERE mgm.GroupId = g.GroupId
                ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS IsE123Migrated,
                ISNULL((
                    SELECT COUNT(*)
                    FROM oe.Members m
                    WHERE m.GroupId = g.GroupId AND m.IsPendingMigration = 1
                ), 0) AS PendingMigrationMemberCount,
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.MigrationGroupMap mgm WHERE mgm.GroupId = g.GroupId
                ) OR EXISTS (
                    SELECT 1 FROM oe.Members m
                    WHERE m.GroupId = g.GroupId AND m.IsPendingMigration = 1
                ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS IsPendingMigration`;

module.exports = {
  GROUP_MIGRATION_STATUS_SELECT_SQL
};
