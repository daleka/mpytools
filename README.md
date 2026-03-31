MPyTools is a Visual Studio Code extension that simplifies working with MicroPython using mpremote. It automates compilation, uploading, and execution of code on a     microcontroller.  
    
    

Dependencies   
The extension requires the following dependencies:    
✅ mpremote – for interacting with MicroPython   
✅ mpy-cross – for compiling .py → .mpy   
✅ zip – for project backup   
✅ micropython-stubs – for autocompletion and type checking in VS Code   
   
    
   
Dependencies are automatically installed when running the "MPY: Install Dependencies" command for the first time.   
   
Features   
🔹 Automatic compilation & upload – Only modified .py files are compiled into .mpy, and only updated files are uploaded to the device.   
🔹 Run code without copying – Execute .py files directly from the host machine.   
🔹 Seamless integration with VS Code – Manage your microcontroller using status bar buttons.   
🔹 Fast project backup – Easily archive your project into a .zip file.   
🔹 Board support – Tested on STM32, expected to work with ESP32, RP2040 (but not verified yet).   
🔹 Automatic installation of MicroPython Stubs – Adds autocompletion and type checking in VS Code (micropython-stubs).    
   
  
    
Future Plans    
🚀 Support for ESP32 and other MicroPython boards   
🚀 Mounting local folders (paused due to mpremote limitations with .mpy files)   
🚀 Expanding support for mpremote commands   
    
         
           
   
Who is this extension for?    
✔ Developers working with MicroPython    
✔ Beginners looking for a quick setup   
✔ Users of STM32, ESP32, RP2040, and similar boards    
     
I’d appreciate any feedback or suggestions!    
   

Urkaine   
-------
      
MPyTools – це розширення для Visual Studio Code, яке спрощує роботу з MicroPython за допомогою mpremote. Воно автоматизує компіляцію, завантаження та виконання коду на          мікроконтролері.       
    
    
    
    
Залежності    
Розширення потребує встановлених:    
✅ mpremote – для взаємодії з MicroPython     
✅ mpy-cross – для компіляції .py → .mpy      
✅ zip – для резервного копіювання      
✅ micropython-stubs – для автодоповнення та перевірки типів у VS Code     
    
    
          
Залежності встановлюються автоматично під час першого запуску команди "MPY: Встановити залежності".    
     
             
Можливості     
🔹 Автоматична компіляція та завантаження – лише змінені .py файли компілюються в .mpy, і лише оновлені файли завантажуються на пристрій.   
🔹 Запуск коду без копіювання – можна виконувати .py файли безпосередньо з ПК.   
🔹 Зручна інтеграція у VS Code – керування мікроконтролером через кнопки у статус-барі.   
🔹 Резервне копіювання – можливість швидко архівувати проєкт у .zip файл.   
🔹 Підтримка плат – протестовано на STM32, очікується сумісність з ESP32, RP2040 (але поки що не перевірено).   
🔹 Автоматичне встановлення MicroPython Stubs – додає автодоповнення та перевірку типів у VS Code (micropython-stubs).   
      
    
    
Плани на майбутнє    
🚀 Підтримка ESP32 та інших плат під MicroPython    
🚀 Монтування локальних папок (відкладено через mpremote і його обмеження роботи з .mpy файлами)    
🚀 Розширення команд для mpremote    
    

               
Для кого це розширення?   
✔ Розробників, які працюють з MicroPython   
✔ Початківців, які хочуть швидко налаштувати середовище   
✔ Користувачів STM32, ESP32, RP2040 та подібних плат   
    
        
            
Буду радий будь-яким відгукам і пропозиціям!       
       
            