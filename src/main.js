import "./style.css";

function generateRandomAddress(length = 40) {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "0x";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function setupGenerator() {
  const display = document.querySelector("#address-display");
  const button = document.querySelector("#generate-btn");

  if (button && display) {
    button.addEventListener("click", () => {
      const address = generateRandomAddress();
      display.textContent = address;
    });
  }
}

setupGenerator();
