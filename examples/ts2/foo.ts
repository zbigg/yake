export function foo() {
    console.log("XY");
}

if (require.main === module) {
    foo();
}