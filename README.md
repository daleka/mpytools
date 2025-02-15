MPyTools is a simple and flexible extension for Visual Studio Code that automates and simplifies the development process for MicroPython.
Built on top of mpremote, it allows you to quickly connect to your microcontroller, execute code, compile .py files to .mpy, copy files, and manage your device directly from VS Code.  
  
  
     
⚠ Required Dependencies  
For MPyTools to work correctly, the following components must be installed: 
 
✅ Install mpremote (for interacting with MicroPython)  
pip install mpremote  
  
✅ Install mpy-cross (for compiling .py → .mpy)  
pip install mpy-cross  
  
✅ Install zip (for archiving and backups)  
On Linux/macOS:  
sudo apt install zip  # Ubuntu/Debian  
brew install zip      # macOS (if using Homebrew)  
  
On Windows: Zip is usually built-in, but if it’s missing, install it via Git Bash or Chocolatey:  
choco install zip
  

  
  
  
🚀 Main Feature – Automation of the Compilation and Upload Process   
MPyTools automatically detects changes in your project files.   
It compiles only the updated .py files into .mpy.   
Only the updated .mpy files are uploaded to the device.    
The microcontroller always stores only the compiled .mpy files, significantly speeding up code execution and saving device resources.   
🔧 How Does MPyTools Work?   
  
  
  
1️⃣ You edit files in the src/ folder on your PC.   
2️⃣ You click on "Compile & Run", after which the extension:   
    Analyzes file changes.   
    Compiles .py → .mpy into the mpy/ folder.   
    Uploads only the updated .mpy files to the device.   
3️⃣ The device stores optimized .mpy files that run faster.   
4️⃣ main.py or another user-specified script is executed.   

  

💡 You work with the source code on your PC, while the microcontroller uses only the .mpy files – this minimizes device load and speeds up code execution!   

  
 
   
🔹 Main Features of MPyTools   
✅ Automatic Connection to MicroPython Device – The extension detects available COM ports and quickly establishes a connection.   
✅ Run Code Without Copying – .py files can be executed directly from the host machine.   
✅ Intelligent File Copying – Only modified files are uploaded, which significantly speeds up development.  
✅ Automatic Compilation (.py → .mpy) – Enhanced performance using mpy-cross.  
✅ Intuitive Management – Buttons in the VS Code status bar provide quick access to all functions.  
✅ Soft and Hardware Reset – Supports Ctrl-D (soft reset) and machine.reset().  
✅ Project Saving – Automatically archives the project into a .zip file for backup.   
✅ Support for Popular Boards – STM32 (tested), ESP32, RP2040 (Raspberry Pi Pico), and others running MicroPython.  
   
  
 
   
🎛 Convenient Management via VS Code Status Bar  
▶ Run – Execute the active .py file.  
⏹ Stop – Stop execution (Ctrl-C).  
🔄 Reset – Soft reset (Ctrl-D).  
🔄 Reload – Restart main.py after a soft reset.  
🔧 Compile & Run – The main button for automatically analyzing changes, compiling, and updating files.  
📂 Save Project – Archives the project for backup.  
🔄 Future Plans  
🚀 Integration with ESP32 and Raspberry Pi Pico  
🚀 Ability to mount a local folder from the host machine  
💡 Since mpremote does not support .mpy files when mounting, this feature will be implemented in the future when proper support is available.  
🚀 Addition of new commands supported by mpremote, gradually expanding the extension’s functionality.  
  

 
   
🏗 Who Is This Extension For?  
✔ Developers working with MicroPython.  
✔ Beginners who want to quickly start working with microcontrollers.  
✔ Users of STM32, ESP32, RP2040 (and other boards).  
✔ Anyone in need of a fast and convenient way to test and upload code.  



  
  
Urkaine    
------------------  
MPyTools – це просте та гнучке розширення для Visual Studio Code, яке автоматизує та спрощує процес розробки під MicroPython.   
Воно побудоване на основі mpremote та дозволяє швидко підключатися до мікроконтролера, виконувати код, компілювати .py у .mpy, копіювати файли та керувати пристроєм прямо з VS Code.  
  
  
⚠ Необхідні залежності  
Для коректної роботи MPyTools необхідно встановити наступні компоненти:  
  
  
✅ Встановити mpremote (для взаємодії з MicroPython)  
pip install mpremote  
  
  
✅ Встановити mpy-cross (для компіляції .py → .mpy)  
pip install mpy-cross  
  
  
✅ Встановити zip (для архівування та резервних копій)  
На Linux/macOS:  
sudo apt install zip  # Ubuntu/Debian  
brew install zip      # macOS (якщо використовуєте Homebrew)  
  
  
На Windows:   
zip зазвичай вбудований, але якщо його немає, встановіть через Git Bash або Chocolatey:  
choco install zip  
 
  
🚀 Головна особливість – автоматизація процесу компіляції та завантаження  
🔹 MPyTools автоматично визначає змінені файли у вашому проєкті  
🔹 Компілює тільки оновлені .py файли у .mpy  
🔹 Завантажує на пристрій лише оновлені .mpy файли  
🔹 На мікроконтролері завжди зберігаються тільки скомпільовані .mpy файли, що значно пришвидшує виконання коду та економить ресурси пристрою  
  
 
🔧 Як працює MPyTools?  
1️⃣ Ви редагуєте файли в папці src/ на своєму ПК  
2️⃣ Натискаєте "Compile & Run", після чого розширення:  
    Аналізує зміни у файлах  
    Компілює .py → .mpy у папку mpy/  
    Завантажує на пристрій лише оновлені .mpy файли  
3️⃣ На пристрої зберігаються оптимізовані .mpy файли, що працюють швидше  
4️⃣ Запускається main.py або інший вказаний користувачем скрипт  
💡 Ви працюєте з вихідним кодом на ПК, а мікроконтролер використовує тільки .mpy файли – це мінімізує навантаження на пристрій та пришвидшує виконання коду!  
  
  
🔹 Основні можливості MPyTools  
✅ Автоматичне підключення до MicroPython-пристрою – розширення визначає доступні COM-порти та швидко встановлює з’єднання  
✅ Запуск коду без копіювання – .py файли можна виконувати напряму з хост-машини  
✅ Інтелектуальне копіювання – завантажуються лише змінені файли, що суттєво прискорює розробку  
✅ Автоматична компіляція .py → .mpy – покращена продуктивність завдяки mpy-cross  
✅ Інтуїтивне управління – кнопки у статус-барі VS Code для швидкого доступу до всіх функцій  
✅ М’який та апаратний перезапуск – підтримка Ctrl-D (soft-reset) та machine.reset()  
✅ Збереження проєкту – автоматичне резервне копіювання у .zip  
✅ Підтримка популярних плат – STM32 (протестовано), ESP32, RP2040 (Raspberry Pi Pico) та інших, що працюють під MicroPython  
  
  
🎛 Зручне управління в статус-барі VS Code  
▶ Run – Запуск активного .py файлу  
⏹ Stop – Зупинка виконання (Ctrl-C)  
🔄 Reset – М'який перезапуск (Ctrl-D)  
🔄 Reload – Перезапуск main.py після soft-reset  
🔧 Compile & Run – Головна кнопка для автоматичного аналізу змін, компіляції та оновлення файлів  
📂 Save Project – Архівування проєкту для резервного копіювання  
  
🔄 Плани на майбутнє  
🚀 Додати інтеграцію з ESP32 та Raspberry Pi Pico  
🚀 Додати можливість монтування локальної папки з хост-машини  
💡 Оскільки mpremote не підтримує .mpy файли при монтуванні, ця функція буде реалізована у майбутньому, коли з’явиться відповідна підтримка  
🚀 Додати нові команди, що підтримує mpremote, поступово розширюючи функціонал розширення  
  
🏗 Для кого це розширення?  
✔ Розробників, які працюють з MicroPython  
✔ Новачків, які хочуть швидко почати роботу з мікроконтролерами  
✔ Користувачів плат STM32, ESP32, RP2040 (та інших)  
✔ Тих, кому потрібен швидкий і зручний спосіб тестування та завантаження коду  
