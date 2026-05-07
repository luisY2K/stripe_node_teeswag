import { faker } from "@faker-js/faker";

export function makeFakeCustomer(): {
  firstName: string;
  lastName: string;
  name: string;
  email: string;
} {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const suffix = faker.string.alphanumeric({ length: 6, casing: "lower" });
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email: `${slug(firstName)}.${slug(lastName)}+${suffix}@teeswag.test`,
  };
}
