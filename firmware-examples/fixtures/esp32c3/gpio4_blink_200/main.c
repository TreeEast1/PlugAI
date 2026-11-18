// Fixture C: GPIO4 toggles every 100 ms (period 200 ms)
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#define HALF_PERIOD_MS 100
void app_main(void) {
    gpio_reset_pin(GPIO_NUM_4);
    gpio_set_direction(GPIO_NUM_4, GPIO_MODE_OUTPUT);
    printf("PLUGAI_FIXTURE gpio4_blink_200\n");
    int level = 0;
    while (1) {
        level = !level;
        gpio_set_level(GPIO_NUM_4, level);
        vTaskDelay(pdMS_TO_TICKS(HALF_PERIOD_MS));
    }
}
