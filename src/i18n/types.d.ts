import common from "../../messages/en/common.json";
import auth from "../../messages/en/auth.json";
import navigation from "../../messages/en/navigation.json";
import admin from "../../messages/en/admin.json";
import employee from "../../messages/en/employee.json";
import expenses from "../../messages/en/expenses.json";
import reports from "../../messages/en/reports.json";
import salary from "../../messages/en/salary.json";
declare module "next-intl" {
  interface AppConfig {
    Messages: {
      common: typeof common;
      auth: typeof auth;
      navigation: typeof navigation;
      admin: typeof admin;
      employee: typeof employee;
      expenses: typeof expenses;
      reports: typeof reports;
      salary: typeof salary;
    };
  }
}
